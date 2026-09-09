# Background job retry behavior

## Behavior

Failed jobs retry at most three times with exponential backoff. Cancellation is
outside this document's scope.
