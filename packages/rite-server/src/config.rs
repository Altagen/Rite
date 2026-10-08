//! Instance configuration as code (ADR 0020).
//!
//! An instance's behaviour is governed by ten settings that, until now, could only be
//! reached from the admin console. A container could be provisioned without a human and
//! then had to wait for one to open a browser and say whether self-registration was
//! allowed. This module is where that stops: a TOML file, environment variables over it,
//! and a validated, typed answer the rest of the server reads instead of the database.
//!
//! Three rules shape everything here.
//!
//! **The operator wins.** Precedence runs environment > file > database > default, and a
//! key declared here is *shadowed*, never written through: whatever the database holds
//! stays untouched and reappears unchanged the day the key leaves the configuration. The
//! opposite direction — the admin page writing a file that outranks the operator — is what
//! Vaultwarden does, and its own documentation records the consequence: one click on Save
//! and every variable the operator set is silently dead.
//!
//! **A key we do not recognise is an error, not a shrug.** A typo in a configuration file
//! must be heard at start-up, named, with the value and what was expected. The alternative
//! is a setting that never applies and an operator who finds out months later.
//!
//! **Valid means the same thing on both paths.** The admin API already refuses a zero
//! refresh floor and an unknown probe method. Those rules live here now and are called from
//! both sides, because two definitions of "valid" drift, and the one that drifts is always
//! the one nobody is looking at.

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Prefix and level separator for the environment form. A *double* underscore separates
/// levels because the keys themselves are `snake_case` — `RITE__dashboard_policy__webui`
/// is unambiguous where a single separator would stop being so the first time a leaf is
/// called `min_interval`. Gitea's convention, and the one Rite already half-uses in
/// `RITE_ADMIN_PASSWORD_FILE`.
const ENV_PREFIX: &str = "RITE__";
const ENV_SEP: &str = "__";
/// Suffix that reads a value from a file instead of the variable, for mounted secrets.
const ENV_FILE_SUFFIX: &str = "__FILE";

/// What a configurable setting looks like, so an unknown key or a wrong shape can be
/// refused by name rather than coerced into something plausible.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shape {
    Bool,
    Text,
    /// A JSON object whose unspecified leaves fall back to the shipped defaults.
    Policy,
}

/// The ten settings an instance may declare. Anything outside this list is a typo.
///
/// `remote_servers` is deliberately absent: it is a desktop client's multiplexer roster
/// (ADR 0012), not instance configuration, and it is stored in the same table only because
/// that table exists.
pub const SETTINGS: &[(&str, Shape)] = &[
    ("instance_name", Shape::Text),
    ("session_persistence", Shape::Bool),
    ("default_shell", Shape::Text),
    ("allow_quick_ssh", Shape::Bool),
    ("open_registration", Shape::Bool),
    ("allow_invitations", Shape::Bool),
    ("confirm_role_change", Shape::Bool),
    ("healthcheck_policy", Shape::Policy),
    ("collection_policy", Shape::Policy),
    ("dashboard_policy", Shape::Policy),
];

fn shape_of(key: &str) -> Option<Shape> {
    SETTINGS.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

/// The shipped default for a policy, so a partially declared one is still whole.
///
/// Declaring `[dashboard_policy] webui = false` must not silently drop `clients` and
/// `minInterval` — the operator said one thing, not three. The leaves they gave are laid
/// over these, and the result is what the instance runs with.
pub fn policy_default(key: &str) -> Value {
    match key {
        "healthcheck_policy" => json!({
            "passiveStatus": true,
            "active": "off",
            "methods": ["tcp-connect"],
            "restrictUsers": [],
            "minInterval": 60,
        }),
        "dashboard_policy" => json!({ "webui": true, "clients": true, "minInterval": 30 }),
        "collection_policy" => json!({
            "allowCreate": true,
            "allowSharingOutsideTeams": true,
            "maxMembers": 0,
            "defaultRole": "viewer",
        }),
        _ => json!({}),
    }
}

/// Where a value came from, in words an operator can act on. A locked field that cannot say
/// which variable locked it sends its reader hunting through a deployment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin(pub String);

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The instance configuration, resolved once at start-up.
#[derive(Clone, Debug, Default)]
pub struct InstanceConfig {
    values: BTreeMap<String, Value>,
    origins: BTreeMap<String, Origin>,
}

impl InstanceConfig {
    /// The declared value for `key`, or `None` when the operator left it alone — in which
    /// case the database and then the shipped default answer, as they always have.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// Where `key` was declared, for the console and for the refusal message.
    pub fn origin(&self, key: &str) -> Option<&Origin> {
        self.origins.get(key)
    }

    pub fn is_managed(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    /// Every managed key, sorted, for `server_mode`'s `managed` list.
    pub fn managed_keys(&self) -> Vec<String> {
        self.values.keys().cloned().collect()
    }

    /// Managed keys with where each was declared, for `server_mode`. The console needs the
    /// origin to render a locked field that explains itself: "greyed out" with no reason
    /// sends its reader hunting through a deployment for a variable they cannot name.
    pub fn managed_origins(&self) -> BTreeMap<String, String> {
        self.origins
            .iter()
            .filter(|(key, _)| self.values.contains_key(*key))
            .map(|(key, origin)| (key.clone(), origin.0.clone()))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Load the file named by `RITE_CONFIG` (when set), lay the environment over it, and
    /// validate the result. Returns an empty configuration when neither is present, which
    /// is every deployment that exists today.
    pub fn load() -> Result<Self> {
        let path = std::env::var("RITE_CONFIG").ok().filter(|p| !p.is_empty());
        let env: Vec<(String, String)> = std::env::vars().collect();
        Self::load_from(path.as_deref(), &env)
    }

    /// The testable half: no process environment, no implicit file.
    pub fn load_from(path: Option<&str>, env: &[(String, String)]) -> Result<Self> {
        let mut raw: BTreeMap<String, Value> = BTreeMap::new();
        let mut origins: BTreeMap<String, Origin> = BTreeMap::new();

        if let Some(path) = path {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading the configuration file at {path}"))?;
            let parsed: toml::Value = toml::from_str(&text)
                .with_context(|| format!("parsing the configuration file at {path}"))?;
            let table = parsed
                .as_table()
                .ok_or_else(|| anyhow!("{path}: the configuration must be a table"))?;
            for (key, value) in table {
                reject_unknown(key, path)?;
                raw.insert(key.clone(), toml_to_json(value));
                origins.insert(key.clone(), Origin(path.to_string()));
            }
        }

        // The environment is laid over the file, leaf by leaf, so a single variable can
        // adjust one corner of a policy without restating the rest of it.
        for (name, value) in env {
            let Some(rest) = name.strip_prefix(ENV_PREFIX) else {
                continue;
            };
            let (rest, from_file) = match rest.strip_suffix(ENV_FILE_SUFFIX) {
                Some(stripped) => (stripped, true),
                None => (rest, false),
            };
            let mut parts = rest.splitn(2, ENV_SEP);
            let key = parts.next().unwrap_or_default().to_string();
            let leaf = parts.next().map(str::to_string);
            reject_unknown(&key, "the environment")?;

            let text = if from_file {
                std::fs::read_to_string(value)
                    .with_context(|| format!("{name}: reading the value from {value}"))?
                    .trim()
                    .to_string()
            } else {
                value.clone()
            };

            match (shape_of(&key), leaf) {
                (Some(Shape::Policy), Some(leaf)) => {
                    let entry = raw.entry(key.clone()).or_insert_with(|| json!({}));
                    let obj = entry.as_object_mut().ok_or_else(|| {
                        anyhow!("{key} was declared as a value in the file, but {name} sets a field inside it")
                    })?;
                    obj.insert(leaf, scalar_from_text(&text));
                }
                (Some(Shape::Policy), None) => bail!(
                    "{name}: {key} is a policy — set one field at a time, \
                     as in {ENV_PREFIX}{key}{ENV_SEP}<field>"
                ),
                (Some(shape), None) => {
                    raw.insert(key.clone(), typed_from_text(shape, &text, name)?);
                }
                (Some(_), Some(leaf)) => bail!("{name}: {key} has no field {leaf}"),
                (None, _) => unreachable!("reject_unknown ran first"),
            }
            origins.insert(key, Origin(name.clone()));
        }

        // Policies are completed from the shipped defaults, then every declared value is
        // held to the same rules the admin API enforces.
        let mut values = BTreeMap::new();
        for (key, value) in raw {
            let value = match shape_of(&key) {
                Some(Shape::Policy) => merge_over_default(&key, value)?,
                _ => value,
            };
            let origin = origins
                .get(&key)
                .cloned()
                .unwrap_or_else(|| Origin("the configuration".into()));
            validate(&key, &value).with_context(|| format!("{origin}: {key} is not valid"))?;
            values.insert(key, value);
        }

        Ok(Self { values, origins })
    }
}

/// A key outside `SETTINGS` stops the server, named, with the list of what was expected.
/// Starting anyway would mean an operator's declaration silently doing nothing.
fn reject_unknown(key: &str, origin: &str) -> Result<()> {
    if shape_of(key).is_some() {
        return Ok(());
    }
    let known = SETTINGS
        .iter()
        .map(|(k, _)| *k)
        .collect::<Vec<_>>()
        .join(", ");
    bail!("{origin}: `{key}` is not a configurable setting. Known settings: {known}")
}

fn merge_over_default(key: &str, declared: Value) -> Result<Value> {
    let mut base = policy_default(key);
    let (Some(base_obj), Some(declared_obj)) = (base.as_object_mut(), declared.as_object()) else {
        bail!("{key} must be a table of fields");
    };
    for (field, value) in declared_obj {
        if !base_obj.contains_key(field) {
            let known = base_obj.keys().cloned().collect::<Vec<_>>().join(", ");
            bail!("{key}: `{field}` is not a field of this policy. Known fields: {known}");
        }
        base_obj.insert(field.clone(), value.clone());
    }
    Ok(base)
}

/// TOML and the environment both arrive as text; the stored policies are JSON, and this is
/// the one place the two meet.
fn toml_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => json!(i),
        toml::Value::Float(f) => json!(f),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(a) => Value::Array(a.iter().map(toml_to_json).collect()),
        toml::Value::Table(t) => Value::Object(
            t.iter()
                .map(|(k, v)| (k.clone(), toml_to_json(v)))
                .collect::<Map<_, _>>(),
        ),
    }
}

/// An environment variable is a string; a policy field may be a boolean, a number or a
/// string. Parse the obvious ones so `RITE__dashboard_policy__webui=false` is a boolean
/// rather than the string "false", which is true in every language that has an opinion.
fn scalar_from_text(text: &str) -> Value {
    match text.trim() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        other => match other.parse::<i64>() {
            Ok(n) => json!(n),
            Err(_) => Value::String(other.to_string()),
        },
    }
}

fn typed_from_text(shape: Shape, text: &str, name: &str) -> Result<Value> {
    match shape {
        Shape::Bool => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "yes" => Ok(Value::Bool(true)),
            "0" | "false" | "off" | "no" => Ok(Value::Bool(false)),
            other => bail!("{name}: `{other}` is not a boolean (use true or false)"),
        },
        Shape::Text => Ok(Value::String(text.trim().to_string())),
        Shape::Policy => unreachable!("policies are handled leaf by leaf"),
    }
}

/// The rules the admin API already enforces, in one place so both paths agree.
///
/// Called from the configuration loader at start-up and from the PATCH handlers at runtime.
/// A refusal here is the difference between an instance that will not start and one that
/// starts with a floor of zero — which is the self-DoS the floor exists to prevent.
pub fn validate(key: &str, value: &Value) -> Result<()> {
    match key {
        "instance_name" | "default_shell" => {
            if !value.is_string() {
                bail!("expected a string");
            }
        }
        "session_persistence"
        | "allow_quick_ssh"
        | "open_registration"
        | "allow_invitations"
        | "confirm_role_change" => {
            if !value.is_boolean() {
                bail!("expected true or false");
            }
        }
        "healthcheck_policy" => {
            let active = value.get("active").and_then(Value::as_str).unwrap_or("off");
            if !["off", "on-demand", "full", "client-choice"].contains(&active) {
                bail!("`active` must be one of off, on-demand, full, client-choice");
            }
            if let Some(methods) = value.get("methods").and_then(Value::as_array) {
                let known = ["tcp-connect", "icmp", "ssh-handshake"];
                if let Some(bad) = methods
                    .iter()
                    .find(|m| !m.as_str().is_some_and(|s| known.contains(&s)))
                {
                    bail!("`{bad}` is not a probe method (tcp-connect, icmp, ssh-handshake)");
                }
            }
        }
        "dashboard_policy" => {
            for field in ["webui", "clients"] {
                if value.get(field).is_some_and(|v| !v.is_boolean()) {
                    bail!("`{field}` must be true or false");
                }
            }
            // Zero means "poll as fast as you like", which is the self-DoS the floor
            // exists to prevent; an hour is past any plausible dashboard.
            if let Some(interval) = value.get("minInterval") {
                match interval.as_u64() {
                    Some(n) if (1..=3600).contains(&n) => {}
                    _ => bail!("`minInterval` must be a whole number of seconds, 1 to 3600"),
                }
            }
        }
        "collection_policy" => {
            let role = value
                .get("defaultRole")
                .and_then(Value::as_str)
                .unwrap_or("viewer");
            if !["viewer", "editor"].contains(&role) {
                bail!("`defaultRole` must be viewer or editor");
            }
            if value.get("maxMembers").and_then(Value::as_i64).unwrap_or(0) < 0 {
                bail!("`maxMembers` must be 0 or more (0 means unlimited)");
            }
        }
        other => bail!("`{other}` is not a configurable setting"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn write(name: &str, body: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("rite-config-{name}-{}.toml", std::process::id()));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn nothing_declared_is_the_deployment_everyone_has_today() {
        let cfg = InstanceConfig::load_from(None, &[]).unwrap();
        assert!(cfg.is_empty());
        assert!(!cfg.is_managed("dashboard_policy"));
        assert_eq!(cfg.managed_keys(), Vec::<String>::new());
    }

    #[test]
    fn a_file_declares_scalars_and_policies() {
        let path = write(
            "basic",
            r#"
instance_name     = "Acme Corp"
open_registration = false

[dashboard_policy]
webui = false
"#,
        );
        let cfg = InstanceConfig::load_from(path.to_str(), &[]).unwrap();
        assert_eq!(cfg.get("instance_name").unwrap(), "Acme Corp");
        assert_eq!(cfg.get("open_registration").unwrap(), &json!(false));
        assert!(cfg.is_managed("dashboard_policy"));
        std::fs::remove_file(path).ok();
    }

    /// Declaring one field must not silently drop the other two: the operator said one
    /// thing, not three.
    #[test]
    fn a_partial_policy_is_completed_from_the_defaults() {
        let path = write("partial", "[dashboard_policy]\nwebui = false\n");
        let cfg = InstanceConfig::load_from(path.to_str(), &[]).unwrap();
        let policy = cfg.get("dashboard_policy").unwrap();
        assert_eq!(policy["webui"], json!(false));
        assert_eq!(
            policy["clients"],
            json!(true),
            "untouched field keeps its default"
        );
        assert_eq!(policy["minInterval"], json!(30));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn the_environment_wins_over_the_file() {
        let path = write("override", "instance_name = \"From the file\"\n");
        let cfg = InstanceConfig::load_from(
            path.to_str(),
            &env(&[("RITE__instance_name", "From the environment")]),
        )
        .unwrap();
        assert_eq!(cfg.get("instance_name").unwrap(), "From the environment");
        assert_eq!(
            cfg.origin("instance_name").unwrap().to_string(),
            "RITE__instance_name"
        );
        std::fs::remove_file(path).ok();
    }

    /// One variable adjusts one corner of a policy; the rest of the file still stands.
    #[test]
    fn a_variable_sets_one_field_of_a_policy_declared_in_the_file() {
        let path = write(
            "leaf",
            "[dashboard_policy]\nwebui = false\nminInterval = 45\n",
        );
        let cfg = InstanceConfig::load_from(
            path.to_str(),
            &env(&[("RITE__dashboard_policy__clients", "false")]),
        )
        .unwrap();
        let policy = cfg.get("dashboard_policy").unwrap();
        assert_eq!(policy["webui"], json!(false), "from the file");
        assert_eq!(policy["clients"], json!(false), "from the environment");
        assert_eq!(policy["minInterval"], json!(45), "from the file");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn booleans_and_numbers_arrive_typed_not_as_text() {
        let cfg = InstanceConfig::load_from(
            None,
            &env(&[
                ("RITE__dashboard_policy__webui", "false"),
                ("RITE__dashboard_policy__minInterval", "120"),
                ("RITE__open_registration", "yes"),
            ]),
        )
        .unwrap();
        assert_eq!(cfg.get("dashboard_policy").unwrap()["webui"], json!(false));
        assert_eq!(
            cfg.get("dashboard_policy").unwrap()["minInterval"],
            json!(120)
        );
        assert_eq!(cfg.get("open_registration").unwrap(), &json!(true));
    }

    #[test]
    fn a_file_suffix_reads_the_value_from_a_mounted_secret() {
        let secret = std::env::temp_dir().join(format!("rite-name-{}.txt", std::process::id()));
        std::fs::write(&secret, "Named by a secret\n").unwrap();
        let cfg = InstanceConfig::load_from(
            None,
            &env(&[("RITE__instance_name__FILE", secret.to_str().unwrap())]),
        )
        .unwrap();
        assert_eq!(cfg.get("instance_name").unwrap(), "Named by a secret");
        std::fs::remove_file(secret).ok();
    }

    /// A typo must be heard at start-up, not discovered months later as a setting that
    /// never applied.
    #[test]
    fn an_unknown_key_refuses_to_start_and_names_itself() {
        let path = write("typo", "open_registratoin = false\n");
        let err = InstanceConfig::load_from(path.to_str(), &[])
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("open_registratoin"),
            "names the offending key: {err}"
        );
        assert!(
            err.contains("open_registration"),
            "lists what was expected: {err}"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn an_unknown_policy_field_refuses_too() {
        let path = write("field", "[dashboard_policy]\nwebiu = false\n");
        let err = InstanceConfig::load_from(path.to_str(), &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("webiu"), "names the offending field: {err}");
        std::fs::remove_file(path).ok();
    }

    /// The same rule as the admin API, on the other path. A floor of zero is the self-DoS
    /// the floor exists to prevent, whichever door it comes through.
    #[test]
    fn the_configuration_is_held_to_the_rules_the_admin_api_enforces() {
        let path = write("invalid", "[dashboard_policy]\nminInterval = 0\n");
        // `{:#}` is the whole chain, which is what an operator sees when start-up fails:
        // "<file>: dashboard_policy is not valid: `minInterval` must be …".
        let err = format!(
            "{:#}",
            InstanceConfig::load_from(path.to_str(), &[]).unwrap_err()
        );
        assert!(err.contains("dashboard_policy"), "names the setting: {err}");
        assert!(
            err.contains("minInterval"),
            "and says which field is wrong: {err}"
        );
        assert!(err.contains("1 to 3600"), "and what was expected: {err}");
        std::fs::remove_file(path).ok();

        assert!(validate("dashboard_policy", &json!({ "minInterval": 0 })).is_err());
        assert!(validate("dashboard_policy", &json!({ "minInterval": 3601 })).is_err());
        assert!(validate("dashboard_policy", &json!({ "minInterval": 30 })).is_ok());
        assert!(validate("healthcheck_policy", &json!({ "active": "sometimes" })).is_err());
        assert!(validate("collection_policy", &json!({ "defaultRole": "owner" })).is_err());
        assert!(validate("collection_policy", &json!({ "maxMembers": -1 })).is_err());
    }

    #[test]
    fn a_non_boolean_for_a_boolean_setting_is_refused_by_name() {
        let err = InstanceConfig::load_from(None, &env(&[("RITE__open_registration", "maybe")]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("RITE__open_registration"), "{err}");
        assert!(err.contains("maybe"), "{err}");
    }

    #[test]
    fn a_policy_cannot_be_set_whole_from_one_variable() {
        let err = InstanceConfig::load_from(None, &env(&[("RITE__dashboard_policy", "{}")]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("one field at a time"), "{err}");
    }

    #[test]
    fn managed_keys_are_what_the_console_will_lock() {
        let cfg = InstanceConfig::load_from(
            None,
            &env(&[
                ("RITE__open_registration", "false"),
                ("RITE__dashboard_policy__webui", "false"),
                ("PATH", "/usr/bin"),
            ]),
        )
        .unwrap();
        assert_eq!(
            cfg.managed_keys(),
            vec![
                "dashboard_policy".to_string(),
                "open_registration".to_string()
            ]
        );
        assert!(
            !cfg.is_managed("instance_name"),
            "undeclared keys stay the console's"
        );
    }
}
