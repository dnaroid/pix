# Support report: renewal reminder preview

Support can reproduce a confusing case:

1. Open a quiet account that should receive the renewal reminder tomorrow.
2. Use the UI preview page to inspect the renewal reminder copy.
3. The next scheduled run decides the account was contacted recently and skips
   the real reminder.

Do not assume the file with preview/reminder wording owns the mutation. The root
cause is expected to be a small assignment in a shared helper.
