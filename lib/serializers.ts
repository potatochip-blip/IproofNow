import type { Role, SubscriptionTier, User } from '@prisma/client';

// Frontend-side string unions (lowercase, snake_case).
// Mirror of frontend `lib/types.ts` UserRole / SubscriptionTier.
export type FrontendRole =
  | 'individual'
  | 'company'
  | 'lawyer'
  | 'law_enforcement'
  | 'government'
  | 'admin';

export type FrontendSubscriptionTier = 'free' | 'pro' | 'business' | 'enterprise';

const ROLE_DB_TO_FRONTEND: Record<Role, FrontendRole> = {
  INDIVIDUAL: 'individual',
  COMPANY: 'company',
  LAWYER: 'lawyer',
  LAW_ENFORCEMENT: 'law_enforcement',
  GOVERNMENT: 'government',
  ADMIN: 'admin',
};

const ROLE_FRONTEND_TO_DB: Record<FrontendRole, Role> = {
  individual: 'INDIVIDUAL',
  company: 'COMPANY',
  lawyer: 'LAWYER',
  law_enforcement: 'LAW_ENFORCEMENT',
  government: 'GOVERNMENT',
  admin: 'ADMIN',
};

const TIER_DB_TO_FRONTEND: Record<SubscriptionTier, FrontendSubscriptionTier> = {
  FREE: 'free',
  PRO: 'pro',
  BUSINESS: 'business',
  ENTERPRISE: 'enterprise',
};

export function roleToFrontend(role: Role): FrontendRole {
  // Records keyed on a closed enum are exhaustive; non-null is the standard
  // workaround for `noUncheckedIndexedAccess`.
  return ROLE_DB_TO_FRONTEND[role]!;
}

export function roleFromFrontend(role: FrontendRole): Role {
  return ROLE_FRONTEND_TO_DB[role]!;
}

export function tierToFrontend(tier: SubscriptionTier): FrontendSubscriptionTier {
  return TIER_DB_TO_FRONTEND[tier]!;
}

export type SerializedUser = {
  id: string;
  email: string;
  name: string;
  role: FrontendRole;
  subscriptionTier: FrontendSubscriptionTier;
  organizationId: string | null;
  organizationName: string | null;
  preferences: {
    theme: 'system';
    language: 'en';
    timezone: 'UTC';
    notifications: {
      email: true;
      push: true;
      proofUpdates: true;
      caseUpdates: true;
      teamActivity: true;
    };
    twoFactorEnabled: false;
  };
  createdAt: string;
  lastLogin: string;
};

type UserWithOrg = User & { org?: { id: string; name: string } | null };

/**
 * The single canonical User → JSON transform. Every endpoint that returns a
 * user MUST go through this function. Never inline `.toLowerCase()` on role
 * elsewhere — that is where casing drift starts.
 *
 * Notes per architecture:
 *   - `stats` is intentionally NOT included here. Stats live in the
 *     /api/dashboard payload (see CLAUDE.md → "user shape vs dashboard shape").
 *   - `preferences` returns hardcoded defaults; no DB column yet. When added,
 *     use a `Json` column rather than flat fields.
 */
export function serializeUser(user: UserWithOrg): SerializedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: roleToFrontend(user.role),
    subscriptionTier: tierToFrontend(user.subscriptionTier),
    organizationId: user.orgId ?? null,
    organizationName: user.org?.name ?? null,
    preferences: {
      theme: 'system',
      language: 'en',
      timezone: 'UTC',
      notifications: {
        email: true,
        push: true,
        proofUpdates: true,
        caseUpdates: true,
        teamActivity: true,
      },
      twoFactorEnabled: false,
    },
    createdAt: user.createdAt.toISOString(),
    lastLogin: (user.lastLoginAt ?? user.createdAt).toISOString(),
  };
}
