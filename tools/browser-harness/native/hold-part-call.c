/*
 * Preloaded into a browser by the export-failures check. Once the file $OCH_HOLD_DIR/arm exists, the browser's
 * first rename of a path ending in ".har.part", or its first open of one that does not create it, waits at its start:
 * the call writes its kind to $OCH_HOLD_DIR/at, waits until $OCH_HOLD_DIR/go exists (at most 120 s), and then runs
 * unchanged. Nothing else is changed: every other call goes straight through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char SUFFIX[] = ".har.part";
static int held;

static int is_part(const char *path) {
  size_t length = path == NULL ? 0 : strlen(path);
  return length >= sizeof SUFFIX - 1 && strcmp(path + length - (sizeof SUFFIX - 1), SUFFIX) == 0;
}

static void hold(const char *kind, const char *path) {
  const char *dir = getenv("OCH_HOLD_DIR");
  char arm[PATH_MAX], at[PATH_MAX], go[PATH_MAX];
  if (dir == NULL || !is_part(path)) return;
  snprintf(arm, sizeof arm, "%s/arm", dir);
  if (access(arm, F_OK) != 0 || __atomic_exchange_n(&held, 1, __ATOMIC_SEQ_CST) != 0) return;
  snprintf(at, sizeof at, "%s/at", dir);
  snprintf(go, sizeof go, "%s/go", dir);
  FILE *note = fopen(at, "we");
  if (note != NULL) {
    fprintf(note, "%s %s\n", kind, path);
    fclose(note);
  }
  const struct timespec tick = {0, 10 * 1000 * 1000};
  for (int waited = 0; waited < 12000 && access(go, F_OK) != 0; waited += 1) nanosleep(&tick, NULL);
}

#define NEXT(name) ((__typeof__(&name))dlsym(RTLD_NEXT, #name))

int rename(const char *from, const char *to) {
  hold("rename", from);
  return NEXT(rename)(from, to);
}

int renameat(int fromdir, const char *from, int todir, const char *to) {
  hold("rename", from);
  return NEXT(renameat)(fromdir, from, todir, to);
}

int renameat2(int fromdir, const char *from, int todir, const char *to, unsigned int flags) {
  hold("rename", from);
  return NEXT(renameat2)(fromdir, from, todir, to, flags);
}

static mode_t mode_of(int flags, va_list args) {
  return (flags & O_CREAT) || (flags & __O_TMPFILE) == __O_TMPFILE ? va_arg(args, mode_t) : 0;
}

#define OPEN(name)                                                                                 \
  int name(const char *path, int flags, ...) {                                                     \
    va_list args;                                                                                  \
    va_start(args, flags);                                                                         \
    mode_t mode = mode_of(flags, args);                                                            \
    va_end(args);                                                                                  \
    if (!(flags & O_CREAT)) hold("open", path);                                                    \
    return NEXT(name)(path, flags, mode);                                                          \
  }
#define OPENAT(name)                                                                               \
  int name(int dir, const char *path, int flags, ...) {                                            \
    va_list args;                                                                                  \
    va_start(args, flags);                                                                         \
    mode_t mode = mode_of(flags, args);                                                            \
    va_end(args);                                                                                  \
    if (!(flags & O_CREAT)) hold("open", path);                                                    \
    return NEXT(name)(dir, path, flags, mode);                                                     \
  }
OPEN(open)
OPEN(open64)
OPENAT(openat)
OPENAT(openat64)

int __open_2(const char *path, int flags) {
  hold("open", path);
  return NEXT(__open_2)(path, flags);
}

int __open64_2(const char *path, int flags) {
  hold("open", path);
  return NEXT(__open64_2)(path, flags);
}
