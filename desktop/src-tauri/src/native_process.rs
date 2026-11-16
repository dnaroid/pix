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

impl OwnedChild {
    /// Reap the leader. On Unix the isolated group is unregistered under the
    /// registry lock right before reaping, so `kill_registered_groups` never
    /// signals a group ID that the OS could already have recycled.
    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        #[cfg(unix)]
        {
            // Like `Child::wait`: close stdin first so a child blocked on
            // input can reach EOF before the non-reaping wait below.
            drop(self.child.stdin.take());
            let pid = self.child.id() as i32;
            let child = &mut self.child;
            reap_registered(pid, || child.wait())
        }
        #[cfg(not(unix))]
        self.child.wait()
    }

    /// Non-blocking variant of [`OwnedChild::wait`] with the same registry rule.
    /// Unix callers poll `exited_before_reap` instead, so it is unused there.
    #[cfg_attr(unix, allow(dead_code))]
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        {
            if !exited_before_reap(self)? {
                return Ok(None);
            }
            self.wait().map(Some)
        }
        #[cfg(not(unix))]
        self.child.try_wait()
    }
}

pub fn spawn(command: &mut Command) -> std::io::Result<OwnedChild> {
    #[cfg(windows)]
    return windows::spawn(command);
    #[cfg(not(windows))]
    command.spawn().map(|child| {
        // `spawn` returns after the child's setpgid, so an isolated child is
        // already its own group leader here.
        #[cfg(unix)]
        register_group(child.id() as i32);
        OwnedChild { child }
    })
}

/// Process groups led by live, unreaped children of this process. App exit
/// kills whatever is still registered once the teardown deadline elapses.
#[cfg(unix)]
static GROUPS: std::sync::Mutex<Option<std::collections::HashSet<i32>>> =
    std::sync::Mutex::new(None);

#[cfg(unix)]
fn groups() -> std::sync::MutexGuard<'static, Option<std::collections::HashSet<i32>>> {
    GROUPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Register `pid` when it leads its own process group (isolated commands and
/// PTY session leaders). Other children share Pix's group and are skipped.
#[cfg(unix)]
pub fn register_group(pid: i32) {
    if pid <= 0 || unsafe { libc::getpgid(pid) } != pid {
        return;
    }
    groups().get_or_insert_with(Default::default).insert(pid);
}

/// Block until `pid` exits without reaping it, then unregister its group and
/// run `reap` under the registry lock. `reap` must reap that same `pid`.
#[cfg(unix)]
pub fn reap_registered<T>(pid: i32, reap: impl FnOnce() -> T) -> T {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
        {
            // Exited (or not waitable): let `reap` observe the real outcome.
            break;
        }
    }
    let mut registered = groups();
    if let Some(set) = registered.as_mut() {
        set.remove(&pid);
    }
    reap()
}

#[cfg(all(test, unix))]
pub fn is_group_registered(pid: i32) -> bool {
    groups().as_ref().is_some_and(|set| set.contains(&pid))
}

/// SIGKILL every still-registered group. Leaders stay unreaped while
/// registered, so each ID still names the group Pix created. Returns how many
/// groups were signalled.
pub fn kill_registered_groups() -> usize {
    #[cfg(unix)]
    {
        let registered = groups();
        registered.as_ref().map_or(0, |set| {
            set.iter()
                .filter(|pgid| unsafe { libc::kill(-**pgid, libc::SIGKILL) } == 0)
                .count()
        })
    }
    // Windows jobs and other platforms already tie descendants to their owner.
    #[cfg(not(unix))]
    0
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
