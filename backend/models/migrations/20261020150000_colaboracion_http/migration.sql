-- CreateTable
CREATE TABLE "CollabDoc" (
    "pageId" TEXT NOT NULL PRIMARY KEY,
    "epoch" TEXT NOT NULL,
    "snapshot" BLOB NOT NULL,
    "lastUpdateId" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CollabDoc_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CollabUpdate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pageId" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollabUpdate_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CollabPresence" (
    "pageId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clock" INTEGER NOT NULL,
    "state" TEXT,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("pageId", "clientId"),
    CONSTRAINT "CollabPresence_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CollabUpdate_pageId_id_idx" ON "CollabUpdate"("pageId", "id");

-- CreateIndex
CREATE INDEX "CollabPresence_pageId_updatedAt_idx" ON "CollabPresence"("pageId", "updatedAt");

