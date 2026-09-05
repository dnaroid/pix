# Retry-key bug fixture

Users report that a second checkout by the same account sometimes reuses the
first checkout's payment idempotency key. Possible causes include the retry-key
cache identity or callers passing the wrong checkout id. Preserve the public
`retryKeyFor(userId, checkoutId)` API.
