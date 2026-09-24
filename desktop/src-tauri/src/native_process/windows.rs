//! Start suspended, attach to a kill-on-close job, then resume the initial thread.
//! `std::process::Command` still owns quoting, environment, handles, and stdio.
use std::{
    io, mem,
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::{Child, Command},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

use super::OwnedChild;

pub struct Job(HANDLE);

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) }; // KILL_ON_JOB_CLOSE cleans up even on error paths.
    }
}

impl Job {
    fn new() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

// std Child has a process handle but not the CREATE_SUSPENDED initial thread handle.
// The suspended child cannot create another thread before we enumerate its one
// initial thread. Never resume until both enumeration and job assignment succeed.
fn resume_initial_thread(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    struct Snapshot(HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    let snapshot = Snapshot(snapshot);
    let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
    if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    loop {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let resumed = unsafe { ResumeThread(thread) };
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(thread) };
            if resumed == u32::MAX {
                return Err(error);
            }
            // A newly created process must have precisely one suspension count.
            if resumed != 1 {
                return Err(io::Error::other("unexpected initial thread suspend count"));
            }
            return Ok(());
        }
        if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "suspended process thread not found",
            ));
        }
    }
}

pub(super) fn spawn(command: &mut Command) -> io::Result<OwnedChild> {
    spawn_with_setup(command, |job, child| {
        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_initial_thread(child.id())
    })
}

fn spawn_with_setup(
    command: &mut Command,
    setup: impl FnOnce(&Job, &Child) -> io::Result<()>,
) -> io::Result<OwnedChild> {
    let job = Job::new()?;
    // CommandExt sets flags rather than merging them. Preserve BackendRuntime's
    // CREATE_NO_WINDOW and keep the initial thread suspended until job ownership.
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child: Child = command.spawn()?;
    if let Err(error) = setup(&job, &child) {
        // The initial thread is still suspended (or resumed just before an
        // anomalous count). Kill and reap before closing the job handle.
        let _ = child.kill();
        let _ = job.terminate();
        let _ = child.wait();
        return Err(error);
    }
    Ok(OwnedChild { child, job })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::Stdio,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn job_helper() {
        match std::env::var("PIX_NATIVE_JOB_TEST").as_deref() {
            Ok("leader") => {
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "native_process::windows::tests::job_helper",
                        "--nocapture",
                    ])
                    .env("PIX_NATIVE_JOB_TEST", "descendant")
                    .stdout(Stdio::inherit())
                    .spawn()
                    .unwrap();
            }
            Ok("descendant") => {
                println!("DESCENDANT_READY");
                io::stdout().flush().unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            _ => {}
        }
    }

    #[test]
    fn natural_exit_closes_descendant_inherited_pipe() {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "native_process::windows::tests::job_helper",
            "--nocapture",
        ])
        .env("PIX_NATIVE_JOB_TEST", "leader")
        .stdout(Stdio::piped());
        let mut child = spawn(&mut cmd).unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut saw_descendant = false;
            while reader.read_line(&mut line).unwrap_or(0) != 0 {
                if line.contains("DESCENDANT_READY") {
                    saw_descendant = true;
                    tx.send(true).ok();
                }
                line.clear();
            }
            tx.send(false).ok();
        });
        // The descendant must have started before cleanup, not merely been
        // queued to start when the leader exits.
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), true);
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "leader did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        super::super::force_stop(&mut child).unwrap();
        // EOF proves the grandchild's inherited stdout was closed by the job.
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), false);
    }

    #[test]
    fn setup_failure_reaps_suspended_child() {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "native_process::windows::tests::job_helper"]);
        let mut pid = 0;
        let error = spawn_with_setup(&mut cmd, |_, child| {
            pid = child.id();
            Err(io::Error::other("injected setup failure"))
        })
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "injected setup failure");
        // The process handle is closed after wait; reopening must fail.
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(handle.is_null(), "suspended child survived setup failure");
        if !handle.is_null() {
            unsafe { CloseHandle(handle) };
        }
    }
}
