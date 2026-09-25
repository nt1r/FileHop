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
        #[arg(long, env = "FILEHOP_MAX_FILE_BYTES", default_value_t = 104_857_600)]
        max_file_bytes: i64,
        #[arg(
            long,
            env = "FILEHOP_FILE_QUOTA_BYTES",
            default_value_t = 1_073_741_824
        )]
        file_quota_bytes: i64,
        #[arg(long, env = "FILEHOP_TRANSFER_ACTIVE_LIMIT", default_value_t = 8)]
        transfer_active_limit: usize,
        #[arg(long, env = "FILEHOP_DISK_RESERVE_BYTES", default_value_t = 67_108_864)]
        disk_reserve_bytes: u64,
        #[arg(long, env = "FILEHOP_PREPARE_TIMEOUT_SECS", default_value_t = 120)]
        prepare_timeout_secs: u64,
        #[arg(long, env = "FILEHOP_UPLOAD_IDLE_SECS", default_value_t = 120)]
        upload_idle_secs: u64,
        #[arg(long, env = "FILEHOP_UPLOAD_TOTAL_SECS", default_value_t = 1800)]
        upload_total_secs: u64,
        #[arg(long, env = "FILEHOP_DOWNLOAD_IDLE_SECS", default_value_t = 120)]
        download_idle_secs: u64,
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
            max_file_bytes,
            file_quota_bytes,
            transfer_active_limit,
            disk_reserve_bytes,
            prepare_timeout_secs,
            upload_idle_secs,
            upload_total_secs,
            download_idle_secs,
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
            if max_file_bytes < 0
                || file_quota_bytes < 0
                || transfer_active_limit == 0
                || prepare_timeout_secs == 0
                || upload_idle_secs == 0
                || upload_total_secs == 0
                || download_idle_secs == 0
            {
                return Err("invalid transfer resource configuration".into());
            }
            let transfer = backend::TransferConfig {
                max_file_size: max_file_bytes,
                quota: file_quota_bytes,
                active_limit: transfer_active_limit,
                disk_reserve: disk_reserve_bytes,
                prepare_timeout: std::time::Duration::from_secs(prepare_timeout_secs),
                idle_timeout: std::time::Duration::from_secs(upload_idle_secs),
                total_timeout: std::time::Duration::from_secs(upload_total_secs),
                download_idle_timeout: std::time::Duration::from_secs(download_idle_secs),
            };
            // 未初始化仍可监听诊断；认证接口独立检查存储，不创建替代实例。
            let status = backend::storage::inspect(&cli.database_dir, &cli.files_dir).await;
            eprintln!("storage_status={}", serde_json::to_string(&status)?);
            // 上传恢复先于监听：尚未裁决的写入和残留不得与新预留并发。
            backend::files_recover(&cli.database_dir, &cli.files_dir).await?;
            let listener = tokio::net::TcpListener::bind(listen).await?;
            println!("listening={}", listener.local_addr()?);
            let app = backend::app_after_recovery(
                cli.database_dir,
                cli.files_dir,
                backend::session::Config {
                    origin,
                    trusted_proxy,
                    transfer,
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
