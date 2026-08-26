import { ConvexError } from "convex/values";

export function validateReleasePoints(points: number) {
  if (!Number.isFinite(points) || points < 0) {
    throw new ConvexError("Assignment Release points must be zero or greater");
  }
  return points;
}

export function adjacentOrder(
  releases: { order: number }[],
  currentOrder: number,
  direction: "up" | "down",
) {
  const ordered = [...releases].sort((left, right) => left.order - right.order);
  const index = ordered.findIndex(({ order }) => order === currentOrder);
  const adjacent = ordered[index + (direction === "up" ? -1 : 1)];
  return adjacent?.order;
}
