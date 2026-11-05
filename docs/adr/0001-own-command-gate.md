# The command gate lives in the extension

The Allowlist/Approval gate runs inside each tool's `execute` and is enforced in every omp approval mode, including `yolo`. Tools declare `approval: "read"` so omp does not prompt a second time.

## Considered Options

- omp `approval(args)` tiers plus `approvalCacheTargets`: rejected, because `yolo` mode bypasses omp approvals and would let any Remote Command run on a Host unchecked.
