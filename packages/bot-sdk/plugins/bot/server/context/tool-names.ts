/*
 * The names of the core tools that prompts and other modules name. A leaf module with no imports, so
 * reading one at a module's top level never meets an import cycle.
 */

/** The Bot's tool for reaching the user: the only way it does. */
export const sendToUserToolName = "send_to_user";

/** The Bot tool that sets a Check-in for itself, with no Approval (#540). */
export const setCheckInToolName = "set_check_in";

/** The Bot tool that cancels one of its pending Check-ins (#540). */
export const cancelCheckInToolName = "cancel_check_in";

/** The Bot tool that lists its pending Check-ins (#540). */
export const listCheckInsToolName = "list_check_ins";
