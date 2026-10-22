import { createHash } from "node:crypto";
import { assertInWriteTransaction } from "./request-context.js";
import * as clock from "../../clock.js";
import { eq } from "drizzle-orm";
import type { OwnerPicture, OwnerRecord, OwnerStore } from "../interface.js";
import { auth_user, owner_picture, settings } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteOwnerStore implements OwnerStore {
  constructor(private db: DrizzleDb) {}

  async update(input: {
    email?: string;
    name?: string;
    avatar?: null;
  }): Promise<OwnerRecord | null> {
    assertInWriteTransaction();
    const owner = await this.find();
    if (!owner) return null;
    if (input.avatar === null)
      await this.db
        .delete(owner_picture)
        .where(eq(owner_picture.user_id, owner.id));
    await this.db
      .update(auth_user)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined && input.email !== owner.email
          ? { email: input.email, emailVerified: false }
          : {}),
        updatedAt: clock.now(),
      })
      .where(eq(auth_user.id, owner.id));
    return this.find();
  }

  async setPicture(input: {
    contentType: string;
    bytes: Uint8Array;
  }): Promise<OwnerRecord | null> {
    assertInWriteTransaction();
    const owner = await this.find();
    if (!owner) return null;
    const bytes = Buffer.from(input.bytes);
    await this.db
      .delete(owner_picture)
      .where(eq(owner_picture.user_id, owner.id));
    await this.db.insert(owner_picture).values({
      user_id: owner.id,
      content_type: input.contentType,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await this.db
      .update(auth_user)
      .set({ updatedAt: clock.now() })
      .where(eq(auth_user.id, owner.id));
    return this.find();
  }

  async findPicture(): Promise<OwnerPicture | null> {
    const owner = await this.find();
    if (!owner) return null;
    const row = await this.db
      .select({
        contentType: owner_picture.content_type,
        bytes: owner_picture.bytes,
        sha256: owner_picture.sha256,
      })
      .from(owner_picture)
      .where(eq(owner_picture.user_id, owner.id))
      .get();
    return row ?? null;
  }

  async find(): Promise<OwnerRecord | null> {
    const claim = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "instance.claim"))
      .get();
    if (!claim) return null;
    const state = JSON.parse(claim.value) as {
      claimed: boolean;
      ownerId: string | null;
    };
    if (!state.claimed || !state.ownerId) return null;
    const rows = await this.db
      .select({
        id: auth_user.id,
        email: auth_user.email,
        name: auth_user.name,
        createdAt: auth_user.createdAt,
        pictureOwner: owner_picture.user_id,
      })
      .from(auth_user)
      .leftJoin(owner_picture, eq(owner_picture.user_id, auth_user.id))
      .where(eq(auth_user.id, state.ownerId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { pictureOwner, ...owner } = row;
    return { ...owner, hasPicture: pictureOwner !== null };
  }
}
