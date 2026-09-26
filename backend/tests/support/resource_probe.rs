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
        std::thread::scope(|scope| {
            for (send, attempt) in attempts {
                let cookie = &cookie;
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    let mut socket = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5)).unwrap();
                    socket.set_write_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
                    write!(socket, "PUT /api/file-sends/{send}/attempts/{attempt}/content HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nCookie: {cookie}\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n").unwrap();
                    let block = [0x5a; 65536];
                    for _ in 0..size / block.len() {
                        socket.write_all(&block).unwrap();
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
                });
            }
        });
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
