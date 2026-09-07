import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, readJson, unauthorized, asString, validateRoomName } from '@/lib/http';
import { getStore } from '@/lib/store';
import { RoomExistsError } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/rooms - every room the user can join. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  try {
    return NextResponse.json({ rooms: await getStore().listRooms() });
  } catch (error) {
    console.error('[rooms:GET]', error);
    return jsonError(500, 'Could not load rooms');
  }
}

/** POST /api/rooms - create a room. Body: { name, topic? } */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const name = validateRoomName(body.name);
  if (!name.ok) return jsonError(400, name.error, name.field);

  try {
    const room = await getStore().createRoom({
      name: name.value,
      topic: asString(body.topic).trim().slice(0, 140),
      createdBy: user.id,
    });
    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomExistsError) {
      return jsonError(409, 'A room with that name already exists', 'name');
    }
    console.error('[rooms:POST]', error);
    return jsonError(500, 'Could not create the room');
  }
}
