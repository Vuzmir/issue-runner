// The worker's only piece of GitHub API surface: one comment on the issue, rewritten rather
// than added to.
//
// Deliberately not gateway.ts. That is the loop's boundary, built around the loop's Config
// and its vocabulary of labels and locks; borrowing it here would tie the Claude adapter to
// the thing it is supposed to be separable from, for the sake of three REST calls.

import { context, getOctokit } from '@actions/github';

/**
 * Reads the issue's existing note, if it has one, and writes back whatever `rewrite` makes of
 * it. Taking a function rather than a body is what lets the caller fold this run into the
 * previous total without the note's identity leaking out of here.
 */
export async function updateNote(
  token: string,
  issue: number,
  marker: string,
  rewrite: (previous: string | undefined) => string,
): Promise<void> {
  const api = getOctokit(token);
  const { owner, repo } = context.repo;

  const comments = await api.paginate(api.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue,
    per_page: 100,
  });

  // Newest first: if an older note ever survives alongside a newer one, the newer is the
  // one carrying the current total.
  const existing = [...comments].reverse().find((comment) => (comment.body ?? '').startsWith(marker));
  const body = rewrite(existing?.body);

  if (existing === undefined) {
    await api.rest.issues.createComment({ owner, repo, issue_number: issue, body });
    return;
  }
  await api.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
}
