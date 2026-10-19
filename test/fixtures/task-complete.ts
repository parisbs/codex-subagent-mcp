import assert from "node:assert/strict";

/**
 * Real `task_complete` lines from Codex session files, the record that closes a turn (#158, ADR 30).
 *
 * Session files under `~/.codex` rotate, so these lines live here and in issue #158. Each is kept
 * exactly as Codex wrote it, apart from the replacement noted on the 0.163.0 lines.
 */

/** codex-cli 0.160.1: the turn that failed because the model was at capacity (2026-10-07). */
export const CAPACITY_0160 =
  "{\"timestamp\":\"2026-10-07T21:34:49.758Z\",\"ordinal\":152,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"01a11843-5494-7521-8419-b605edb4752c\",\"last_agent_message\":null,\"error\":{\"message\":\"Selected model is at capacity. Please try a different model.\",\"codex_error_info\":\"server_overloaded\"},\"started_at\":1791408428,\"completed_at\":1791408889,\"duration_ms\":461527,\"time_to_first_token_ms\":4793}}";
export const CAPACITY_0160_TURN = "01a11843-5494-7521-8419-b605edb4752c";

/** codex-cli 0.162.1: a usage limit, the negative case. */
export const USAGE_LIMIT_0162 =
  "{\"timestamp\":\"2026-10-16T18:39:49.097Z\",\"ordinal\":36,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"root_turn_id\":\"01a14602-f59f-7bc1-b6e5-d297594edffa\",\"turn_id\":\"01a14602-f59f-7bc1-b6e5-d297594edffa\",\"last_agent_message\":null,\"error\":{\"message\":\"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:19 PM.\",\"codex_error_info\":\"usage_limit_exceeded\"},\"started_at\":1792175961,\"completed_at\":1792175989,\"duration_ms\":27588,\"time_to_first_token_ms\":3816}}";
export const USAGE_LIMIT_0162_TURN = "01a14602-f59f-7bc1-b6e5-d297594edffa";

/** codex-cli 0.154.0, the supported floor: a usage limit on the second turn of a resumed thread. */
export const USAGE_LIMIT_0154 =
  "{\"timestamp\":\"2026-09-14T18:56:41.853Z\",\"ordinal\":251,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"01a0a145-ce25-7750-8784-3876f269b68c\",\"last_agent_message\":null,\"error\":{\"message\":\"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:20 PM.\",\"codex_error_info\":\"usage_limit_exceeded\"},\"started_at\":1789412101,\"completed_at\":1789412201,\"duration_ms\":100174,\"time_to_first_token_ms\":17861}}";
export const USAGE_LIMIT_0154_TURN = "01a0a145-ce25-7750-8784-3876f269b68c";

/**
 * codex-cli 0.163.0, one thread in file order: a turn OpenAI rejected for an invalid output schema
 * (`other`), then a follow-up that answered. Only the working directory was replaced.
 */
export const THREAD_0163 = {
  failedContext:
    "{\"timestamp\":\"2026-10-19T20:33:09.000Z\",\"ordinal\":5,\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"01a155de-317a-7cb2-979c-1e2dde26430d\",\"root_turn_id\":\"01a155de-317a-7cb2-979c-1e2dde26430d\",\"disabled_plugin_ids\":[],\"cwd\":\"/workspace/project\",\"approval_policy\":\"never\",\"approvals_reviewer\":\"user\",\"sandbox_policy\":{\"type\":\"read-only\"},\"permission_profile\":{\"type\":\"managed\",\"file_system\":{\"type\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"}]},\"network\":\"restricted\"},\"model\":\"gpt-5.6-luna\",\"comp_hash\":\"3000\",\"collaboration_mode\":{\"mode\":\"default\",\"settings\":{\"model\":\"gpt-5.6-luna\",\"reasoning_effort\":\"low\",\"developer_instructions\":null}},\"multi_agent_version\":\"v1\",\"realtime_active\":false,\"cyber_access_program\":\"standard\",\"effort\":\"low\",\"summary\":\"none\"}}",
  failed:
    "{\"timestamp\":\"2026-10-19T20:33:09.457Z\",\"ordinal\":10,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"root_turn_id\":\"01a155de-317a-7cb2-979c-1e2dde26430d\",\"turn_id\":\"01a155de-317a-7cb2-979c-1e2dde26430d\",\"last_agent_message\":null,\"error\":{\"message\":\"{\\\"type\\\":\\\"error\\\",\\\"error\\\":{\\\"message\\\":\\\"Invalid schema for response_format 'codex_output_schema': 'schema.additionalProperties' is required to be supplied and to be false when strict is true.\\\",\\\"type\\\":\\\"invalid_request_error\\\",\\\"param\\\":\\\"text.format.schema\\\",\\\"code\\\":\\\"invalid_json_schema\\\"},\\\"status\\\":400}\",\"codex_error_info\":\"other\"},\"started_at\":1792441987,\"completed_at\":1792441989,\"duration_ms\":1993}}",
  followUpContext:
    "{\"timestamp\":\"2026-10-19T20:33:40.196Z\",\"ordinal\":14,\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"01a155de-a94b-7b11-9750-f541bdef8d51\",\"root_turn_id\":\"01a155de-a94b-7b11-9750-f541bdef8d51\",\"disabled_plugin_ids\":[],\"cwd\":\"/workspace/project\",\"approval_policy\":\"never\",\"approvals_reviewer\":\"user\",\"sandbox_policy\":{\"type\":\"read-only\"},\"permission_profile\":{\"type\":\"managed\",\"file_system\":{\"type\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"}]},\"network\":\"restricted\"},\"model\":\"gpt-5.6-luna\",\"comp_hash\":\"3000\",\"collaboration_mode\":{\"mode\":\"default\",\"settings\":{\"model\":\"gpt-5.6-luna\",\"reasoning_effort\":\"low\",\"developer_instructions\":null}},\"multi_agent_version\":\"v1\",\"realtime_active\":false,\"cyber_access_program\":\"standard\",\"effort\":\"low\",\"summary\":\"none\"}}",
  followUp:
    "{\"timestamp\":\"2026-10-19T20:33:41.288Z\",\"ordinal\":21,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"root_turn_id\":\"01a155de-a94b-7b11-9750-f541bdef8d51\",\"turn_id\":\"01a155de-a94b-7b11-9750-f541bdef8d51\",\"last_agent_message\":\"OK\",\"started_at\":1792442018,\"completed_at\":1792442021,\"duration_ms\":3132,\"time_to_first_token_ms\":3012}}",
};
export const THREAD_0163_FAILED_TURN = "01a155de-317a-7cb2-979c-1e2dde26430d";
export const THREAD_0163_FOLLOW_UP_TURN = "01a155de-a94b-7b11-9750-f541bdef8d51";

/**
 * The same line with its envelope `timestamp` replaced. A record counts for a run only when it was
 * written no earlier than the run was spawned (ADR 30), so a test that needs a real record to belong
 * to the run it starts moves the timestamp past that moment; nothing else in the line changes.
 */
export function restamp(line: string, writtenAt: Date): string {
  const record = JSON.parse(line) as Record<string, unknown>;
  return JSON.stringify({ ...record, timestamp: writtenAt.toISOString() });
}

/** A moment safely after any spawn in the test that asks for it. */
export function afterSpawn(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

/**
 * Asserts the capacity note says each thing #158 requires (AC-1), loosely, so the wording stays the
 * implementation's: the cause is a temporary capacity limit on OpenAI's side, not the task or the
 * configuration; the run's changes persist; and a follow-up, a later retry or another model remain.
 */
export function assertCapacityNote(note: string | null | undefined): asserts note is string {
  assert.ok(note, "a capacity note");
  assert.match(note, /OpenAI/, "the cause is on OpenAI's side");
  assert.match(note, /capacity/i);
  assert.match(note, /temporar/i, "the limit is temporary");
  assert.match(note, /task/i, "not a problem with the task");
  assert.match(note, /configuration/i, "nor with the configuration");
  assert.match(note, /persist/i, "the run's changes persist");
  assert.match(note, /working directory|worktree/i);
  assert.match(note, /codex_follow_up/, "a follow-up can retrieve the report");
  assert.match(note, /later/i, "or the caller can retry later");
  assert.match(note, /(another|different|other) model/i, "or choose another model");
}
