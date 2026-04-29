import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

const CATEGORIES = [
  { slug: 'appliance', name: 'Appliance', icon: 'washing-machine', sortOrder: 10 },
  { slug: 'hvac', name: 'HVAC', icon: 'thermometer', sortOrder: 20 },
  { slug: 'plumbing', name: 'Plumbing', icon: 'droplet', sortOrder: 30 },
  { slug: 'electrical', name: 'Electrical', icon: 'zap', sortOrder: 40 },
  { slug: 'exterior', name: 'Exterior', icon: 'home', sortOrder: 50 },
  { slug: 'vehicle', name: 'Vehicle', icon: 'car', sortOrder: 60 },
  { slug: 'tool', name: 'Tool', icon: 'wrench', sortOrder: 70 },
  { slug: 'landscaping', name: 'Landscaping', icon: 'leaf', sortOrder: 80 },
  { slug: 'other', name: 'Other', icon: 'box', sortOrder: 99 },
];

async function main() {
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, icon: c.icon, sortOrder: c.sortOrder },
    });
  }
  console.log(`Seeded ${CATEGORIES.length} categories.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
