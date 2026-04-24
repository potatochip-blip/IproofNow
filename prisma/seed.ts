import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../lib/password';

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'prisma/seed.ts must NOT run in production — it creates default credentials.'
  );
}

const prisma = new PrismaClient();

const SEED_PASSWORD = 'dev-password-123';

const SEED_USERS: ReadonlyArray<{ email: string; name: string; role: Role }> = [
  { email: 'individual@iproofnow.dev',      name: 'Iris Individual', role: 'INDIVIDUAL' },
  { email: 'company@iproofnow.dev',         name: 'Cory Company',    role: 'COMPANY' },
  { email: 'lawyer@iproofnow.dev',          name: 'Lara Lawyer',     role: 'LAWYER' },
  { email: 'law-enforcement@iproofnow.dev', name: 'Leo Lawman',      role: 'LAW_ENFORCEMENT' },
  { email: 'government@iproofnow.dev',      name: 'Gabe Government', role: 'GOVERNMENT' },
  { email: 'admin@iproofnow.dev',           name: 'Adam Admin',      role: 'ADMIN' },
];

async function main() {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const u of SEED_USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash,
      },
    });
  }

  console.log(`✓ Seeded ${SEED_USERS.length} users (one per role).`);
  console.log(`  password = "${SEED_PASSWORD}"`);
  for (const u of SEED_USERS) console.log(`  - ${u.role.padEnd(16)} ${u.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
