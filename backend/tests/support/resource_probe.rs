use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    sync::{Arc, Barrier},
};

fn memory_kib(pid: u32, field: &str) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

// 临时/正式路径在提交边界可能是同一 inode 的硬链接，不能重复计费。
fn sampled_bytes(files: &std::path::Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    let mut partial = 0;
    for entry in std::fs::read_dir(files).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "storage-id" {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => panic!("storage sample failed: {error}"),
        };
        assert!(metadata.is_file());
        if entry.file_name().to_string_lossy().ends_with(".partial") {
            partial += metadata.len();
        }
        if seen.insert((metadata.dev(), metadata.ino())) {
            total += metadata.len();
        }
    }
    (total, partial)
}

fn stored_bytes(files: &std::path::Path) -> u64 {
    std::fs::read_dir(files)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_name() == "storage-id" {
                return 0;
            }
            let metadata = entry.metadata().unwrap();
            assert!(metadata.is_file(), "unexpected storage directory");
            metadata.len()
        })
        .sum()
}

// 独立后端进程避免把测试客户端的内存算进服务端；每组重新启动，峰值不受前组影响。
// 这是 Linux 上的有限资源验收，不是性能承诺或长期压测；只使用一次性合成文件。
#[tokio::test]
#[ignore = "Linux resource acceptance: run explicitly with --ignored --nocapture"]
async fn bounded_memory_for_file_sizes_and_concurrent_transfers() {
    let mut growth = Vec::new();
    for (size, concurrent) in [
        (1024 * 1024, 1),
        (100 * 1024 * 1024, 1),
        (100 * 1024 * 1024, 3),
    ] {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database");
        let files = root.path().join("files");
        std::fs::create_dir(&database).unwrap();
        std::fs::create_dir(&files).unwrap();
        backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
            .await
            .unwrap();
        let (server, address) = super::start(&database, &files);
        let (_, login) = super::http(
            address,
            "POST",
            "/api/session",
            "",
            r#"{"username":"Admin","password":" synthetic password "}"#,
        );
        let cookie = login
            .lines()
            .find_map(|line| line.strip_prefix("set-cookie: "))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let baseline = memory_kib(server.0.id(), "VmRSS:");
        let barrier = Arc::new(Barrier::new(concurrent));
        // 准入竞争可明确返回 429；先逐个准备，再同时发文件体，测量的是获准传输而非抢锁。
        let attempts: Vec<_> = (0..concurrent).map(|_| {
            let send = uuid::Uuid::new_v4();
            let attempt = uuid::Uuid::new_v4();
            let input = serde_json::json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"resource.bin","size":size,"mime":"application/octet-stream","source_label":"Resource probe"}).to_string();
            assert_eq!(super::http(address, "POST", "/api/file-sends", &cookie, &input).0, 200);
            (send, attempt)
        }).collect();
        let (checkpoint_tx, checkpoint_rx) = std::sync::mpsc::channel();
        let done = std::sync::atomic::AtomicBool::new(false);
        let peaks = std::thread::scope(|scope| {
            let sampler = scope.spawn(|| {
                let mut peaks = (0, 0);
                while !done.load(std::sync::atomic::Ordering::Acquire) {
                    let sample = sampled_bytes(&files);
                    peaks.0 = peaks.0.max(sample.0);
                    peaks.1 = peaks.1.max(sample.1);
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                peaks
            });
            let mut workers = Vec::new();
            let mut resumes = Vec::new();
            for (send, attempt) in attempts {
                let cookie = &cookie;
                let barrier = barrier.clone();
                let (resume_tx, resume_rx) = std::sync::mpsc::channel();
                resumes.push(resume_tx);
                let checkpoint_tx = checkpoint_tx.clone();
                workers.push(scope.spawn(move || {
                    barrier.wait();
                    let mut socket = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5)).unwrap();
                    socket.set_write_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
                    write!(socket, "PUT /api/file-sends/{send}/attempts/{attempt}/content HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nCookie: {cookie}\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n").unwrap();
                    let block = [0x5a; 65536];
                    for chunk in 0..size / block.len() {
                        socket.write_all(&block).unwrap();
                        if chunk + 1 == size / block.len() / 2 {
                            checkpoint_tx.send(()).unwrap();
                            resume_rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
                        }
                    }
                    let mut response = String::new();
                    socket.read_to_string(&mut response).unwrap();
                    assert_eq!(&response[9..12], "200", "{response}");
                    let message: serde_json::Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
                    let file_id = message["file_id"].as_str().unwrap();
                    // 下载也逐块消费并检查内容，不能让客户端完整缓冲掩盖服务端问题。
                    let mut socket = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5)).unwrap();
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
                    write!(socket, "GET /api/files/{file_id} HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n").unwrap();
                    let mut reader = BufReader::new(socket);
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    assert!(line.starts_with("HTTP/1.1 200"));
                    loop {
                        line.clear(); reader.read_line(&mut line).unwrap();
                        assert!(!line.is_empty(), "truncated headers");
                        if line == "\r\n" { break; }
                    }
                    let mut buffer = [0; 65536];
                    let mut received = 0;
                    loop {
                        let count = reader.read(&mut buffer).unwrap();
                        if count == 0 { break; }
                        assert!(buffer[..count].iter().all(|byte| *byte == 0x5a));
                        received += count;
                    }
                    assert_eq!(received, size);
                }));
            }
            // 所有写入者停在半程，等待服务端实际落盘后再采样；不拿最终总量冒充暂存证据。
            let expected = (size * concurrent / 2) as u64;
            let checkpoint = std::panic::catch_unwind(|| {
                for _ in 0..concurrent {
                    checkpoint_rx
                        .recv_timeout(std::time::Duration::from_secs(15))
                        .unwrap();
                }
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                loop {
                    let (total, partial) = sampled_bytes(&files);
                    if partial == expected {
                        assert_eq!(total, expected);
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "halfway storage did not converge"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            });
            for resume in resumes {
                let _ = resume.send(());
            }
            let results: Vec<_> = workers.into_iter().map(|worker| worker.join()).collect();
            done.store(true, std::sync::atomic::Ordering::Release);
            let peaks = sampler.join().unwrap();
            checkpoint.unwrap();
            for result in results {
                result.unwrap();
            }
            // 合并后台采样与稳定半程检查点，避免依赖采样线程恰好被调度。
            (peaks.0.max(expected), peaks.1.max(expected))
        });
        assert!(peaks.0 <= (size * concurrent) as u64);
        assert!(peaks.1 <= (size * concurrent) as u64);
        println!(
            "storage sample: unique_entity_peak_bytes={} partial_peak_bytes={}",
            peaks.0, peaks.1
        );
        assert_eq!(stored_bytes(&files), (size * concurrent) as u64);
        let peak = memory_kib(server.0.id(), "VmHWM:");
        let delta = peak.saturating_sub(baseline);
        println!(
            "resource probe: bytes={size} concurrency={concurrent} baseline_kib={baseline} peak_kib={peak} growth_kib={delta} stored_bytes={}",
            stored_bytes(&files)
        );
        // 允许运行时/分配器波动，但拒绝单个 100 MiB 文件或并发文件整体入内存。
        assert!(
            delta < 64 * 1024,
            "server memory exceeded bounded probe budget"
        );
        growth.push(delta);
    }
    assert!(
        growth[1] < growth[0] + 32 * 1024,
        "memory scales with file size"
    );
}
