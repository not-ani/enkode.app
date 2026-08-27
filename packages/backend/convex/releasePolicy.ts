import { ConvexError } from "convex/values";

export function validateReleasePoints(points: number) {
  if (!Number.isFinite(points) || points < 0) {
    throw new ConvexError("Assignment Release points must be zero or greater");
  }
  return points;
}

type ReleasePublication = {
  publicationState?: "draft" | "scheduled" | "published";
  publishedAt?: number;
  scheduledFor?: number;
};

export function releasePublicationStatus(release: ReleasePublication, now = Date.now()) {
  if (release.publicationState === "draft") return "draft" as const;
  if (release.publicationState === "scheduled") {
    return release.scheduledFor !== undefined && release.scheduledFor <= now
      ? ("published" as const)
      : ("scheduled" as const);
  }
  if (release.publicationState === "published") return "published" as const;

  // Assignment Releases created before publication states were introduced were immediate.
  return release.publishedAt !== undefined && release.publishedAt <= now
    ? ("published" as const)
    : ("draft" as const);
}

export function validateScheduledFor(scheduledFor: number, now = Date.now()) {
  if (!Number.isFinite(scheduledFor) || scheduledFor <= now) {
    throw new ConvexError("Scheduled publication must be a future date and time");
  }
  return scheduledFor;
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
