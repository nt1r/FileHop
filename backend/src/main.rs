use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf};
use tokio::signal;

#[derive(Parser)]
struct Cli {
    #[arg(long, env = "FILEHOP_DATABASE_DIR", default_value = "/data/database")]
    database_dir: PathBuf,
    #[arg(long, env = "FILEHOP_FILES_DIR", default_value = "/data/files")]
    files_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Init {
        #[arg(long)]
        username: String,
        /// Confirm both explicitly selected target directories before writing.
        #[arg(long, required = true)]
        confirm_paths: bool,
    },
    Serve {
        #[arg(long, default_value = "0.0.0.0:8080")]
        listen: SocketAddr,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Init {
            username,
            confirm_paths: _,
        } => {
            eprintln!(
                "Database directory: {}\nFiles directory: {}",
                cli.database_dir.display(),
                cli.files_dir.display()
            );
            let password = rpassword::prompt_password("Password: ")?;
            backend::storage::initialize(&cli.database_dir, &cli.files_dir, &username, &password)
                .await?;
            println!("Initialization completed.");
        }
        Command::Serve { listen } => {
            // Diagnose storage before listening; business writes are not registered.
            let status = backend::storage::inspect(&cli.database_dir, &cli.files_dir).await;
            eprintln!("storage_status={}", serde_json::to_string(&status)?);
            let listener = tokio::net::TcpListener::bind(listen).await?;
            println!("listening={}", listener.local_addr()?);
            axum::serve(listener, backend::app(cli.database_dir, cli.files_dir))
                .with_graceful_shutdown(shutdown())
                .await?;
        }
    }
    Ok(())
}

async fn shutdown() {
    let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        result = signal::ctrl_c() => { result.expect("listen for Ctrl+C"); }
        _ = terminate.recv() => {}
    }
}
