import { serializeError } from "serialize-error";

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]");
  if (reason instanceof Error) {
    console.error("Error name:", reason.name);
    console.error("Error message:", reason.message);
    console.error("Stack:", reason.stack);
    console.error("Serialized:", JSON.stringify(serializeError(reason), null, 2));
  } else {
    console.error("Reason:", reason);
    console.error("Type:", typeof reason);
    try {
      console.error("JSON:", JSON.stringify(reason, null, 2));
    } catch { 
      console.error("(non-serializable)");
    }
  }
  console.error("Promise:", promise);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]");
  console.error("Error name:", error.name);
  console.error("Error message:", error.message);
  console.error("Stack:", error.stack);
  console.error("Serialized:", JSON.stringify(serializeError(error), null, 2));
});
