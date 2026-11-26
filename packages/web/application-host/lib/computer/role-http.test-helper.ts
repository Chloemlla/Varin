import { expect } from 'vitest';

export async function expectOk<T = unknown>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}
