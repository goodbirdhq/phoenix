# Environments own Schedules

Schedules are persisted and evaluated by their allocated execution Environment rather than by a client or cloud control plane. This preserves Phoenix's environment-owned execution model and allows Schedules to run without a connected client; an offline Environment catches up when its server returns, while clients cannot mutate it until then.
