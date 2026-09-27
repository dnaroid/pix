// Include the production parser in this test translation unit so assertions
// exercise native record parsing rather than a TypeScript reimplementation.
#define main ol_supervisor_main
#include "owned-launch-supervisor.c"
#undef main

int main(void) {
  if (service_presence_from_exit(0) != 1 || service_presence_from_exit(113) != 0) return 5;
  const int uncertain[] = { -1, 1, 5, 64, 127, 137 };
  for (size_t i = 0; i < sizeof(uncertain) / sizeof(uncertain[0]); i++) {
    if (service_presence_from_exit(uncertain[i]) != -1) return 6;
  }
  const char *worker = "role=worker pid=123 pidversion=456 token=00000000000000000000000000000000000000000000007b00000000000001c8 cid=abc boot=123.000456 start=42\n";
  const char *owned = "role=owned boot=123.000456 cid=abc worker_pid=123 worker_pidversion=456 worker_token=00000000000000000000000000000000000000000000007b00000000000001c8 journaled_at=42\n";
  ol_worker_t w;
  ol_owned_t o;
  if (parse_worker_record(worker, &w) || w.cid != 0xabc || parse_owned_record(owned, &o) || o.cid != 0xabc) return 1;
  char altered[512];
  snprintf(altered, sizeof(altered), "%sX", worker);
  if (parse_worker_record(altered, &w) == 0) return 2;
  snprintf(altered, sizeof(altered), "%sX", owned);
  if (parse_owned_record(altered, &o) == 0) return 3;
  if (parse_worker_record("role=worker pid=123 pidversion=456 token=00000000000000000000000000000000000000000000007b00000000000001c8 cid=abc boot=123.1000000 start=42\n", &w) == 0) return 4;
  return 0;
}
