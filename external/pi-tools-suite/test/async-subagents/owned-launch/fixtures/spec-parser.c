#include <stdio.h>
#include <string.h>
#include "owned-launch-common.h"

int main(int argc, char **argv) {
  if (argc != 3) return 3;
  ol_spec_t spec;
  int valid = ol_load_spec(argv[1], &spec) == 0;
  if (valid && strcmp(argv[2], "valid") == 0) {
    int ok = spec.args_count == 2 && spec.env_count == 1 &&
             strcmp(spec.args[0], "") == 0 &&
             strcmp(spec.args[1], "line1\nline2=foo") == 0 &&
             strcmp(spec.env[0], "PROMPT=a\nb=c") == 0;
    char path[OL_PATH_MAX], stale[OL_PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/atomic-test", argv[1]) >= (int)sizeof(path) ||
        snprintf(stale, sizeof(stale), "%s.tmp", path) >= (int)sizeof(stale)) return 6;
    int fd = open(stale, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0 || close(fd) != 0 || ol_write_atomic(path, "one", 3, 0600, 1) ||
        ol_write_atomic(path, "two", 3, 0600, 1)) return 7;
    ol_spec_free(&spec);
    return ok ? 0 : 4;
  }
  ol_spec_free(&spec);
  return !valid && strcmp(argv[2], "invalid") == 0 ? 0 : 5;
}
