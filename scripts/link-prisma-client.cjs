const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const prismaClientPkg = path.join(workspaceRoot, "node_modules", "@prisma", "client");
const prismaClientTarget = path.join(prismaClientPkg, ".prisma");
const prismaClientSource = path.join(workspaceRoot, "node_modules", ".prisma");

try {
  if (!fs.existsSync(prismaClientSource)) {
    console.warn("Prisma client source not found:", prismaClientSource);
    process.exit(0);
  }

  if (fs.existsSync(prismaClientTarget)) {
    process.exit(0);
  }

  const relativeSource = path.relative(prismaClientPkg, prismaClientSource);
  fs.symlinkSync(relativeSource, prismaClientTarget, process.platform === "win32" ? "junction" : "dir");
} catch (error) {
  console.error("Failed to link Prisma client:", error);
  process.exit(1);
}
