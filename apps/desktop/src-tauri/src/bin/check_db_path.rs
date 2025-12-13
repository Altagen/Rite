//! Utility to check where the database will be created
//!
//! Run with: cargo run --bin check_db_path

fn main() {
    // Compile-time detection
    #[cfg(target_os = "linux")]
    println!("🐧 Compiled for: Linux");

    #[cfg(target_os = "macos")]
    println!("🍎 Compiled for: macOS");

    #[cfg(target_os = "windows")]
    println!("🪟 Compiled for: Windows");

    // Runtime detection via dirs
    if let Some(data_dir) = dirs::data_dir() {
        let db_path = data_dir.join("rite").join("vault.db");
        println!("📁 Database will be created at:");
        println!("   {}", db_path.display());

        println!("\n📂 Parent directory:");
        println!("   {}", data_dir.display());
    } else {
        eprintln!("❌ Could not determine data directory!");
    }

    // Show other relevant paths
    println!("\n📍 Other directories:");

    if let Some(config) = dirs::config_dir() {
        println!("   Config:  {}", config.display());
    }

    if let Some(cache) = dirs::cache_dir() {
        println!("   Cache:   {}", cache.display());
    }

    if let Some(home) = dirs::home_dir() {
        println!("   Home:    {}", home.display());
    }
}
