/*
 * Run by the export-failures check: `mask-proc-fd <pid>` mounts an empty tmpfs over /proc/<pid>/fd inside that
 * browser's own mount namespace, so /proc/self/fd there leads nowhere. It enters the user namespace the harness made
 * for the browser (the parent of the browser's own), where this user is root, then the browser's mount namespace.
 * It refuses a process that shares this one's mount namespace, so nothing outside the browser's namespace changes.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define NS_GET_PARENT 0xb702

static int fail(const char *what) {
  perror(what);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) return fail("usage: mask-proc-fd <pid>");
  long pid = strtol(argv[1], NULL, 10);
  if (pid <= 1) return fail("pid");
  char path[64];
  struct stat own, theirs;
  snprintf(path, sizeof path, "/proc/%ld/ns/mnt", pid);
  if (stat("/proc/self/ns/mnt", &own) != 0 || stat(path, &theirs) != 0) return fail("stat mnt");
  if (own.st_ino == theirs.st_ino && own.st_dev == theirs.st_dev) {
    fputs("refused: the process shares this mount namespace\n", stderr);
    return 1;
  }
  int mnt = open(path, O_RDONLY | O_CLOEXEC);
  snprintf(path, sizeof path, "/proc/%ld/ns/user", pid);
  int user = open(path, O_RDONLY | O_CLOEXEC);
  if (mnt < 0 || user < 0) return fail("open ns");
  int parent = ioctl(user, NS_GET_PARENT);
  if (parent < 0) return fail("parent user namespace");
  if (setns(parent, CLONE_NEWUSER) != 0) return fail("enter user namespace");
  if (setns(mnt, CLONE_NEWNS) != 0) return fail("enter mount namespace");
  snprintf(path, sizeof path, "/proc/%ld/fd", pid);
  if (mount("och-mask", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4k") != 0)
    return fail("mount");
  return 0;
}
