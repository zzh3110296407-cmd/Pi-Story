// Development-safe format validator. Contains no scenario text or gold answers.
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const text = Type.String({ minLength: 1, pattern: '\\S' });
const record = Type.Record(Type.String(), Type.Unknown());
const event = Type.Object({
  type: Type.Union(['authorMessage', 'steer', 'followUp', 'continue'].map(value => Type.Literal(value))),
  text,
  at: Type.Optional(text),
});
const action = Type.Union([
  Type.Object({ tool: text, argsMatch: Type.Optional(record) }),
  Type.Object({ reply: Type.Literal(true) }),
]);
const setup = Type.Union([
  Type.Object({ step: Type.Literal('open'), constraints: record, bible: record, outline: record }),
  Type.Object({ step: Type.Literal('commitChapters'), count: Type.Integer({ minimum: 0 }), texts: Type.Array(text), keeperHooks: Type.Array(Type.Array(record)) }),
  Type.Object({ step: Type.Union([Type.Literal('command'), Type.Literal('authorMessage')]), text }),
  Type.Object({ step: Type.Literal('toolCall'), tool: text, args: record, result: Type.Object({ ok: Type.Literal(false), error: Type.Object({ code: text, message: text }) }) }),
]);
const execution = {
  internalRoles: Type.Union([Type.Literal('real'), Type.Literal('faux')]),
  maxShowrunnerRequests: Type.Integer({ minimum: 1 }),
  maxChapterAttempts: Type.Integer({ minimum: 1 }),
  onBoundExceeded: Type.Literal('record_failure_and_stop'),
  targetChapterMaximum: Type.Optional(Type.Integer({ minimum: 1 })),
  start: Type.Optional(event),
  afterTrigger: Type.Optional(Type.Array(event)),
  dialogResponses: Type.Optional(Type.Array(Type.Object({
    on: Type.Literal('ask_author'), reply: text,
    delayUntilAssertion: Type.Literal('automatic_continuation_paused'),
  }))),
  fauxProfile: Type.Optional(record),
  usageSnapshot: Type.Optional(Type.Object({
    knownUsd: Type.Number({ minimum: 0 }), unknownReservationsUsd: Type.Number({ minimum: 0 }),
    conservativeTotalUsd: Type.Number({ minimum: 0 }), status: text,
  })),
};
function schema(version) {
  return Type.Object({
    schema: Type.Literal(`story/p3-scenario@${version}`), id: text,
    split: Type.Union([Type.Literal('dev'), Type.Literal('acceptance')]), category: text,
    mode: Type.Union([Type.Literal('real'), Type.Literal('faux')]), storyPrompt: Type.Optional(Type.String()),
    setup: Type.Array(setup), trigger: event,
    expect: Type.Object({ acceptable: Type.Array(action, { minItems: 1 }), forbidden: Type.Array(action),
      programChecks: Type.Array(text), judgeChecks: Type.Array(text) }),
    execution: Type.Object(version === 1 ? { ...execution, stopAfterFirstAction: Type.Boolean() } : {
      ...execution, stopAt: Type.Literal('decisive_action'), maxReadOnlyCalls: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
  });
}
export const scenarioV1Schema = schema(1);
export const scenarioV2Schema = schema(2);
export const readOnlyTools = Object.freeze(['read_story', 'read_chapter', 'read_state', 'get_character']);

export function validateScenario(value) {
  const expected = value?.schema === 'story/p3-scenario@2' ? scenarioV2Schema : scenarioV1Schema;
  if (!Check(expected, value)) throw new Error('Invalid P3 scenario format');
  if (value.category === 'E01') {
    if ((value.storyPrompt ?? '') !== '' || value.setup.length !== 0) throw new Error('E01 must precede the first story prompt');
  } else if (!value.storyPrompt?.trim()) throw new Error('A nonblank author story prompt is required');
  for (const step of value.setup) {
    if (step.step === 'commitChapters' && (step.count !== step.texts.length || step.count !== step.keeperHooks.length))
      throw new Error('Preparation chapter/hook count mismatch');
  }
  for (const actions of [value.expect.acceptable, value.expect.forbidden]) {
    for (const entry of actions) {
      if (entry.tool && entry.reply) throw new Error('An action cannot be both tool and reply');
      for (const [key, primitive] of Object.entries(entry.argsMatch ?? {})) {
        if (!/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/u.test(key) ||
          (primitive !== null && !['string', 'number', 'boolean'].includes(typeof primitive)))
          throw new Error('argsMatch requires a field path and primitive equality');
      }
    }
  }
  if (value.schema === 'story/p3-scenario@2' && value.expect.acceptable.some(action => readOnlyTools.includes(action.tool)))
    throw new Error('A read is preparation, not an acceptable decisive action');
  return value;
}
