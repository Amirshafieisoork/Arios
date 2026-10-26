import { publicState } from './domain.mjs';

/** Login status is derived from protected profiles, never editable domain fields. */
export async function workspaceState(repo, state, userId) {
  const snapshot = publicState(state, userId);
  if (snapshot.user.role !== 'manager') return snapshot;
  const links = new Map((await repo.listProfileLinks()).map(profile => [profile.domain_user_id, profile]));
  snapshot.users = snapshot.users.map(person => {
    const profile = links.get(person.id);
    return { ...person, loginEnabled: Boolean(profile && !person.deletedAt), loginNeedsReview: Boolean(profile && profile.role !== person.role) };
  });
  return snapshot;
}
