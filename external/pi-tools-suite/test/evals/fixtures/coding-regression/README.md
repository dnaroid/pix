# Discount rounding bug fixture

A customer reports a one-cent overcharge on percentage discounts. The policy is
to floor the final discounted price. Fix the behavior without weakening input
validation or changing the exported function signature.
