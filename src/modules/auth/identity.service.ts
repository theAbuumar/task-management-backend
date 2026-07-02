// Find-or-create across login providers (auth_tz.md §1, §3–§5, §7).
//
// The single place that turns a provider profile (Google/GitHub/Telegram) into a
// local account. Order of resolution:
//   1. Match an existing identity by (provider, provider_user_id) → return its user.
//   2. Else, if the provider gave a VERIFIED email that matches an existing account,
//      auto-merge: attach this identity to that account (auth_tz.md §5).
//   3. Else, create a fresh account plus this identity.
//
// Never throws "already exists"/"not found" — that find-or-create contract is the
// whole point (auth_tz.md §1). Email+password is the only flow that doesn't use this.

import type { PrismaClient, User, AuthProvider } from '@prisma/client';

export interface ProviderProfile {
  /** One of the OAuth/Telegram providers (not `email`). */
  provider: Extract<AuthProvider, 'google' | 'github' | 'telegram'>;
  /** Stable provider id: Google `sub`, GitHub numeric id, Telegram id. */
  provider_user_id: string;
  /** Provider-supplied email, if any (Telegram accounts have none). */
  email?: string | null;
  /** Whether the provider vouches the email is verified — gates auto-merge (§5). */
  email_verified?: boolean;
  display_name?: string | null;
  avatar_url?: string | null;
}

function deriveDisplayName(profile: ProviderProfile): string {
  if (profile.display_name && profile.display_name.trim()) return profile.display_name.trim();
  const local = profile.email?.split('@')[0];
  if (local) return local;
  return `${profile.provider}-user`;
}

/**
 * Resolve a provider profile to a local user, creating/merging as needed.
 * Runs in a transaction so the merge (lookup + attach) and the create paths are atomic.
 */
export async function findOrCreateFromProvider(
  prisma: PrismaClient,
  profile: ProviderProfile,
): Promise<User> {
  return prisma.$transaction(async (tx) => {
    // 1. Existing identity for this exact provider account.
    const identity = await tx.authIdentity.findUnique({
      where: {
        provider_provider_user_id: {
          provider: profile.provider,
          provider_user_id: profile.provider_user_id,
        },
      },
      include: { user: true },
    });
    if (identity) return identity.user;

    // 2. Auto-merge onto an existing account by verified email (§5).
    if (profile.email && profile.email_verified) {
      const existing = await tx.user.findUnique({ where: { email: profile.email } });
      if (existing) {
        await tx.authIdentity.create({
          data: {
            user_id: existing.id,
            provider: profile.provider,
            provider_user_id: profile.provider_user_id,
            provider_email: profile.email,
          },
        });
        return existing;
      }
    }

    // 3. Brand-new account plus its first identity.
    return tx.user.create({
      data: {
        email: profile.email ?? null,
        email_verified: profile.email_verified ?? false,
        display_name: deriveDisplayName(profile),
        avatar_url: profile.avatar_url ?? null,
        identities: {
          create: {
            provider: profile.provider,
            provider_user_id: profile.provider_user_id,
            provider_email: profile.email ?? null,
          },
        },
      },
    });
  });
}
