# Schedule responsibility ends at the durable Thread Trigger

An Occurrence triggers successfully when Phoenix durably creates its Thread and accepts the first Turn. Schedules serialize only that Trigger, so resulting agent runs may overlap and the spawned Thread follows ordinary Phoenix lifecycle and failure behavior from that point onward.
