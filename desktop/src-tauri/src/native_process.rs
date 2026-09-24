use std::process::{Child, Command};

#[cfg(windows)]
#[path = "native_process/windows.rs"]
mod windows;

/// The job remains open through leader exit, so descendants cannot outlive cleanup.
pub struct OwnedChild {
    child: Child,
    #[cfg(windows)]
    job: windows::Job,
}

impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

pub fn spawn(command: &mut Command) -> std::io::Result<OwnedChild> {
    #[cfg(windows)]
    return windows::spawn(command);
    #[cfg(not(windows))]
    command.spawn().map(|child| OwnedChild { child })
}

/// Isolate the adapter and its nested pi processes in a process group.
pub fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

/// Kill descendants even when the adapter itself has already exited.
pub fn force_stop(child: &mut OwnedChild) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(std::io::Error::last_os_error())
    }
    #[cfg(windows)]
    {
        child.job.terminate()
    }
    #[cfg(not(any(unix, windows)))]
    {
        child.kill()
    }
}

/// On Unix, observe exit without reaping the group leader: its PID cannot be
/// recycled as another group's ID until cleanup has signalled the group.
pub fn exited_before_reap(child: &OwnedChild) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(error);
        }
        Ok(info.si_signo == libc::SIGCHLD)
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        Ok(false)
    }
}
