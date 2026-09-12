import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const decodeThreadResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse);

it("preserves Codex resume errors introduced after the generated protocol", () => {
  const schemas = [
    CodexSchema.ServerNotification__SubAgentActivityKind,
    CodexSchema.V2ItemStartedNotification__SubAgentActivityKind,
    CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind,
    CodexSchema.V2ThreadReadResponse__SubAgentActivityKind,
    CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind,
  ];

  for (const schema of schemas) {
    assert.equal(Schema.is(schema)("completed"), true);
  }

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(Schema.is(CodexSchema.ServerNotification__CollabAgentTool)(tool), true);
    assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool)(tool), true);
  }

  assert.equal(
    Schema.is(CodexSchema.ServerNotification__CollabAgentToolCallStatus)("interrupted"),
    true,
  );
  assert.equal(
    Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus)("interrupted"),
    true,
  );

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.154.0",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          error: {
            codexErrorInfo: "misalignmentPolicyViolation",
            message: "The prior turn was blocked by policy.",
          },
          id: "turn-1",
          status: "failed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };

  const decoded = decodeThreadResumeResponse(resumeResponse);
  assert.deepEqual(decoded.thread.turns[0]?.error, {
    codexErrorInfo: "misalignmentPolicyViolation",
    message: "The prior turn was blocked by policy.",
  });

  const structuredErrorResponse = {
    ...resumeResponse,
    thread: {
      ...resumeResponse.thread,
      turns: [
        {
          ...resumeResponse.thread.turns[0],
          error: {
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
            message: "The response stream disconnected.",
          },
        },
      ],
    },
  };
  assert.equal(isThreadResumeResponse(structuredErrorResponse), true);

  const malformedErrorResponse = {
    ...resumeResponse,
    thread: {
      ...resumeResponse.thread,
      turns: [
        {
          ...resumeResponse.thread.turns[0],
          error: {
            codexErrorInfo: 503,
            message: "Malformed error code.",
          },
        },
      ],
    },
  };
  assert.equal(isThreadResumeResponse(malformedErrorResponse), false);
});

it("accepts Codex 0.150 account plan values", () => {
  const planTypes = [
    "self_serve_business_prolite",
    "ent26",
    "enterprise_cbp_automation",
    "edu_plus",
    "edu_pro",
  ];

  for (const planType of planTypes) {
    const accountResponse = {
      account: {
        email: "user@example.com",
        planType,
        type: "chatgpt",
      },
      requiresOpenaiAuth: true,
    };

    assert.equal(isGetAccountResponse(accountResponse), true);
  }
});
