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
    ResetPassword,
    Serve {
        #[arg(long, default_value = "0.0.0.0:8080")]
        listen: SocketAddr,
        #[arg(
            long,
            env = "FILEHOP_ORIGIN",
            default_value = "https://filehop.invalid"
        )]
        origin: String,
        #[arg(long, env = "FILEHOP_TRUSTED_PROXY")]
        trusted_proxy: Option<std::net::IpAddr>,
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
        Command::ResetPassword => {
            eprintln!(
                "Database directory: {}\nFiles directory: {}",
                cli.database_dir.display(),
                cli.files_dir.display()
            );
            let password = rpassword::prompt_password("Password: ")?;
            backend::storage::reset_password(&cli.database_dir, &cli.files_dir, &password).await?;
            println!("Password reset completed; all sessions revoked.");
        }
        Command::Serve {
            listen,
            origin,
            trusted_proxy,
        } => {
            // Origin 来自显式配置，绝不根据来访请求的 Host 推断可信站点。
            let uri: axum::http::Uri = origin.parse()?;
            if uri.scheme_str() != Some("https")
                || uri.authority().is_none()
                || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
                || origin.ends_with('/')
                || origin.contains('@')
            {
                return Err(
                    "FILEHOP_ORIGIN must be an exact HTTPS origin without trailing slash".into(),
                );
            }
            // 未初始化仍可监听诊断；认证接口独立检查存储，不创建替代实例。
            let status = backend::storage::inspect(&cli.database_dir, &cli.files_dir).await;
            eprintln!("storage_status={}", serde_json::to_string(&status)?);
            let listener = tokio::net::TcpListener::bind(listen).await?;
            println!("listening={}", listener.local_addr()?);
            let app = backend::app_with_config(
                cli.database_dir,
                cli.files_dir,
                backend::session::Config {
                    origin,
                    trusted_proxy,
                    ..Default::default()
                },
            );
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
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
