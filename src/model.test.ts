import { describe, expect, it } from 'vitest';

import { chooseModel, expandModel } from './model.js';

describe('expandModel', () => {
  it('spells out the short form as a model ID', () => {
    expect(expandModel('opus4.8')).toBe('claude-opus-4-8');
    expect(expandModel('opus5.0')).toBe('claude-opus-5');
    expect(expandModel('opus5')).toBe('claude-opus-5');
    expect(expandModel('Sonnet-5')).toBe('claude-sonnet-5');
  });

  it('passes aliases and full IDs through untouched', () => {
    expect(expandModel('sonnet')).toBe('sonnet');
    expect(expandModel('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

describe('chooseModel', () => {
  it('falls back to the action default without a model label', () => {
    expect(chooseModel(['status:open', 'bug'], 'model:', 'sonnet')).toEqual({
      model: 'sonnet',
      label: undefined,
      warning: undefined,
    });
  });

  it('takes the model from the label', () => {
    const choice = chooseModel(['status:open', 'model:opus4.8'], 'model:', 'sonnet');
    expect(choice.model).toBe('claude-opus-4-8');
    expect(choice.label).toBe('model:opus4.8');
    expect(choice.warning).toBeUndefined();
  });

  it('ignores an empty label', () => {
    expect(chooseModel(['model:'], 'model:', 'sonnet').model).toBe('sonnet');
  });

  it('uses the first of several labels and says so', () => {
    const choice = chooseModel(['model:opus5.0', 'model:opus4.8'], 'model:', 'sonnet');
    expect(choice.model).toBe('claude-opus-5');
    expect(choice.warning).toContain('model:opus4.8');
  });
});
