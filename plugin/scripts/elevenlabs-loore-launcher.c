#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/prctl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef ALLOWED_UID
#error "compile with -DALLOWED_UID=<openclaw uid>"
#endif
#ifndef BROKER_UID
#error "compile with -DBROKER_UID=<dedicated uid>"
#endif
#ifndef BROKER_GID
#error "compile with -DBROKER_GID=<dedicated gid>"
#endif

#ifndef BUN_PATH
#define BUN_PATH "/usr/local/libexec/loore-elevenlabs-bun"
#endif

#ifndef BRIDGE_PATH
#define BRIDGE_PATH "/usr/local/libexec/loore-elevenlabs-api.ts"
#endif

static int fail(const char *message) {
  fprintf(stderr, "loore-elevenlabs-api: %s\n", message);
  return 126;
}

static int close_inherited_fds(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) == 0) return 0;
  if (errno != ENOSYS && errno != EINVAL) return -1;
#endif

  DIR *directory = opendir("/proc/self/fd");
  if (directory != NULL) {
    const int directory_fd = dirfd(directory);
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
      char *end = NULL;
      errno = 0;
      const long fd = strtol(entry->d_name, &end, 10);
      if (errno == 0 && end != entry->d_name && *end == '\0' && fd >= 3 && fd != directory_fd) {
        close((int)fd);
      }
    }
    closedir(directory);
    return 0;
  }

  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return -1;
  rlim_t maximum = limit.rlim_cur;
  if (maximum == RLIM_INFINITY) maximum = 1048576;
  for (rlim_t fd = 3; fd < maximum; fd += 1) close((int)fd);
  return 0;
}

static int set_broker_limits(void) {
  const struct rlimit no_core = {0, 0};
  const struct rlimit cpu = {180, 180};
  const struct rlimit address_space = {768UL * 1024UL * 1024UL, 768UL * 1024UL * 1024UL};
  const struct rlimit file_size = {128UL * 1024UL * 1024UL, 128UL * 1024UL * 1024UL};
  const struct rlimit processes = {64, 64};
  const struct rlimit files = {64, 64};
  return setrlimit(RLIMIT_CORE, &no_core) || setrlimit(RLIMIT_CPU, &cpu) ||
         setrlimit(RLIMIT_AS, &address_space) || setrlimit(RLIMIT_FSIZE, &file_size) ||
         setrlimit(RLIMIT_NPROC, &processes) || setrlimit(RLIMIT_NOFILE, &files);
}

int main(int argc, char **argv) {
  const uid_t caller = getuid();
  if (caller != (uid_t)ALLOWED_UID && caller != 0) {
    return fail("caller is not authorized");
  }
  if (geteuid() != 0) {
    return fail("launcher is not installed setuid-root");
  }
  if (argc < 2 || argc > 64) {
    return fail("invalid argument count");
  }

  size_t total = 0;
  for (int i = 1; i < argc; i += 1) {
    const size_t length = strnlen(argv[i], 4097);
    if (length == 0 || length > 4096) return fail("invalid argument length");
    total += length;
    if (total > 32768) return fail("argument bytes exceed safety cap");
  }

  if (clearenv() != 0 || setenv("PATH", "/usr/bin:/bin", 1) != 0 ||
      setenv("HOME", "/nonexistent", 1) != 0 || setenv("LANG", "C.UTF-8", 1) != 0) {
    return fail("cannot sanitize environment");
  }
  umask(077);
  if (chdir("/") != 0) return fail("cannot enter safe working directory");
  if (close_inherited_fds() != 0) return fail("cannot close inherited file descriptors");

  const int lock_fd = open("/run/lock/loore-elevenlabs-api.lock", O_RDWR | O_CREAT, 0600);
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    return fail("another broker request is already running");
  }
  if (set_broker_limits() != 0) return fail("cannot set broker resource limits");
  if (setgroups(0, NULL) != 0 || setresgid((gid_t)BROKER_GID, (gid_t)BROKER_GID, (gid_t)BROKER_GID) != 0 ||
      setresuid((uid_t)BROKER_UID, (uid_t)BROKER_UID, (uid_t)BROKER_UID) != 0) {
    return fail("cannot establish dedicated broker identity");
  }
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return fail("cannot apply broker process protections");
  }
  signal(SIGALRM, SIG_DFL);
  alarm(135);

  char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (child_argv == NULL) return fail("out of memory");
  child_argv[0] = (char *)BUN_PATH;
  child_argv[1] = (char *)BRIDGE_PATH;
  for (int i = 1; i < argc; i += 1) child_argv[i + 1] = argv[i];
  child_argv[argc + 1] = NULL;

  execv(BUN_PATH, child_argv);
  fprintf(stderr, "loore-elevenlabs-api: exec failed: %s\n", strerror(errno));
  return 126;
}
