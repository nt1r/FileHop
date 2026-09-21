use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

/// Exercise a real terminal. Kill the child on timeout; never pass passwords in argv.
pub fn terminal(mut command: CommandBuilder, password: &str) -> (bool, String) {
    command.env("NO_COLOR", "1");
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 || tx.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = Vec::new();
    let mut sent = false;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("terminal timed out");
        };
        match rx.recv_timeout(remaining) {
            Ok(bytes) => {
                output.extend(bytes);
                if !sent && String::from_utf8_lossy(&output).contains("Password: ") {
                    // rpassword prints its prompt before disabling ECHO. Wait for the
                    // actual terminal state instead of racing it or using a fixed delay.
                    let fd = pair.master.as_raw_fd().unwrap();
                    // SAFETY: master owns this descriptor throughout the borrowed use.
                    let fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
                    while rustix::termios::tcgetattr(fd)
                        .unwrap()
                        .local_modes
                        .contains(rustix::termios::LocalModes::ECHO)
                    {
                        if Instant::now() >= deadline {
                            child.kill().unwrap();
                            child.wait().unwrap();
                            panic!("terminal echo remained enabled");
                        }
                        thread::sleep(Duration::from_millis(2));
                    }
                    writeln!(writer, "{password}").unwrap();
                    sent = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) => {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("terminal timed out");
            }
        }
    }
    let success = child.wait().unwrap().success();
    (success, String::from_utf8_lossy(&output).into_owned())
}
