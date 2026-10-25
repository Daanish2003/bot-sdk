import { createServerFn } from "@tanstack/react-start";

// Whether the Bot page shows Memory, Skills and Knowledge: the Host lists those features only with
// a Computer, so without one their routes don't exist and the browser asks first.
export const getComputerFeaturesOn = createServerFn({ method: "GET" }).handler(async () => {
  const { computerFeaturesOn } = await import("@/services");
  return computerFeaturesOn;
});
