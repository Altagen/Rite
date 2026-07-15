/**
 * Certificate trust modal (ADR 0012 phase 4 — TOFU).
 *
 * When a remote presents a self-signed certificate (one that public CAs don't
 * vouch for), we show its SHA-256 fingerprint and ask the user to confirm it
 * out-of-band before pinning — the same trust-on-first-use pattern as the SSH
 * host-key modal. A real (CA-signed) cert never reaches this dialog.
 */

interface Props {
  url: string;
  fingerprint: string;
  busy: boolean;
  onTrust: () => void;
  onCancel: () => void;
}

/** Group a hex fingerprint into colon-separated byte pairs for readability. */
function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,2}/g) ?? []).join(':').toUpperCase();
}

export function CertTrustModal({ url, fingerprint, busy, onTrust, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
        <h2 className="text-lg font-semibold">Untrusted certificate</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground break-all">{url}</span> presents a
          self-signed certificate that no public authority vouches for. Verify the fingerprint
          below matches the server out-of-band before you trust it.
        </p>
        <div className="mt-3 rounded border border-border bg-muted/50 p-2">
          <p className="text-xs text-muted-foreground">SHA-256 fingerprint</p>
          <code className="mt-1 block break-all font-mono text-xs">
            {formatFingerprint(fingerprint)}
          </code>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Once pinned, later connections must present this exact certificate.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onTrust}
            disabled={busy}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            Trust &amp; add
          </button>
        </div>
      </div>
    </div>
  );
}
