/**
 * Per-issue model selection.
 *
 * An issue can carry a `model:<name>` label to override the action's `model` input for its
 * own runs. Nothing about the label is checked against a list of known models: whatever it
 * names goes to the CLI's `--model`, so a new model works the day it ships. The one courtesy
 * is the short form people actually type - `opus4.8`, `sonnet5.0` - which the CLI does not
 * accept, and which is spelled out here as the model ID it stands for.
 */

/**
 * The short names `ensureLabels` pre-creates, same idea as `STATUS_DEFINITIONS` in statuses.ts:
 * a label anyone can click onto an issue without first typing a model ID by hand. This list is
 * a starting offer, not a wall - `chooseModel` reads whatever `model:` label is actually there,
 * short form or full ID, whether or not it appears here.
 */
export const MODEL_LABEL_DEFINITIONS: Record<string, { color: string; description: string }> = {
  'opus5.5': { color: '5319E7', description: 'Work this issue with Claude Opus 5.5' },
  'opus5.0': { color: '5319E7', description: 'Work this issue with Claude Opus 5' },
  'opus4.8': { color: '5319E7', description: 'Work this issue with Claude Opus 4.8' },
  'haiku4.5': { color: 'C5DEF5', description: 'Work this issue with Claude Haiku 4.5' },
};

export interface ModelChoice {
  model: string;
  /** Which label chose it, or undefined when the action's default applies. */
  label: string | undefined;
  warning: string | undefined;
}

/** `opus4.8` -> `claude-opus-4-8`, `opus5.0` -> `claude-opus-5`; anything else is left alone. */
export function expandModel(name: string): string {
  const short = /^([a-z]+)-?(\d+)(?:\.(\d+))?$/i.exec(name);
  if (short === null) return name;
  const [, family, major, minor] = short;
  const version = minor === undefined || minor === '0' ? major : `${major}-${minor}`;
  return `claude-${family?.toLowerCase()}-${version}`;
}

export function chooseModel(labels: readonly string[], prefix: string, fallback: string): ModelChoice {
  const matching = labels.filter(
    (label) => label.startsWith(prefix) && label.slice(prefix.length).trim() !== '',
  );
  const label = matching[0];
  if (label === undefined) return { model: fallback, label: undefined, warning: undefined };

  return {
    model: expandModel(label.slice(prefix.length).trim()),
    label,
    warning:
      matching.length > 1
        ? `carries ${matching.map((name) => `\`${name}\``).join(', ')}; using \`${label}\``
        : undefined,
  };
}
