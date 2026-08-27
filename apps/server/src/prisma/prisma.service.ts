import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ItemInstanceLocation, Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    const client = this;
    const extendedClient = this.$extends({
      query: {
        itemInstance: {
          async update({
            args,
            query,
          }: {
            args: Prisma.ItemInstanceUpdateArgs;
            query: (args: Prisma.ItemInstanceUpdateArgs) => Promise<unknown>;
          }): Promise<unknown> {
            if (!client.isWorldDropTransition(args.data)) {
              return query(args);
            }

            const target = await client.itemInstance.findUnique({
              where: args.where,
              select: {
                id: true,
                _count: {
                  select: {
                    equippedSubItems: true,
                  },
                },
              },
            });
            if ((target?._count.equippedSubItems ?? 0) > 0) {
              throw new Error(
                'INTEGRITY_NESTED_DROP_BLOCKED: move nested sub-items to inventory before WORLD_DROP.',
              );
            }
            return query(args);
          },
          async updateMany({
            args,
            query,
          }: {
            args: Prisma.ItemInstanceUpdateManyArgs;
            query: (args: Prisma.ItemInstanceUpdateManyArgs) => Promise<unknown>;
          }): Promise<unknown> {
            if (!client.isWorldDropTransition(args.data)) {
              return query(args);
            }

            const blockedCount = await client.itemInstance.count({
              where: {
                AND: [args.where ?? {}, { equippedSubItems: { some: {} } }],
              },
            });
            if (blockedCount > 0) {
              throw new Error(
                'INTEGRITY_NESTED_DROP_BLOCKED: move nested sub-items to inventory before WORLD_DROP.',
              );
            }
            return query(args);
          },
        },
      },
    });
    Object.assign(this, extendedClient);
  }

  private isWorldDropTransition(
    data:
      | Prisma.ItemInstanceUpdateInput
      | Prisma.ItemInstanceUncheckedUpdateInput
      | Prisma.ItemInstanceUpdateManyMutationInput
      | Prisma.ItemInstanceUncheckedUpdateManyInput
      | undefined,
  ): boolean {
    const locationUpdate = data?.location;
    if (!locationUpdate) {
      return false;
    }

    if (typeof locationUpdate === 'object' && 'set' in locationUpdate) {
      return locationUpdate.set === ItemInstanceLocation.WORLD_DROP;
    }

    return locationUpdate === ItemInstanceLocation.WORLD_DROP;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
