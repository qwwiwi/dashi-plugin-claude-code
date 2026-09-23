#define _GNU_SOURCE
#include <errno.h>
#include <linux/prctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef ALLOWED_UID
#error "compile with -DALLOWED_UID=<openclaw uid>"
#endif

#ifndef BUN_PATH
#define BUN_PATH "/home/openclaw/.local/bin/bun"
#endif

#ifndef BRIDGE_PATH
#define BRIDGE_PATH "/usr/local/libexec/loore-elevenlabs-api.ts"
#endif

static int fail(const char *message) {
  fprintf(stderr, "loore-elevenlabs-api: %s\n", message);
  return 126;
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

  if (setresgid(0, 0, 0) != 0 || setresuid(0, 0, 0) != 0) {
    return fail("cannot establish broker identity");
  }
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    return fail("cannot disable process dumps");
  }
  if (clearenv() != 0 || setenv("PATH", "/usr/bin:/bin", 1) != 0 ||
      setenv("HOME", "/nonexistent", 1) != 0 || setenv("LANG", "C.UTF-8", 1) != 0) {
    return fail("cannot sanitize environment");
  }
  umask(077);
  if (chdir("/") != 0) return fail("cannot enter safe working directory");

  long max_fd = sysconf(_SC_OPEN_MAX);
  if (max_fd < 0 || max_fd > 65536) max_fd = 65536;
  for (int fd = 3; fd < max_fd; fd += 1) close(fd);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return fail("cannot enable no-new-privileges");
  }

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
