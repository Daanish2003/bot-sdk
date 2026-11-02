// The assignments module's entry point: other modules import it only through this file.
export {
  assignmentsAtTurnStart,
  assignmentTitleOf,
  assignWorkToolName,
  exportAssignments,
  finishAssignmentToolName,
  listAssignments,
  wakeOnAssignments,
} from "./assignment";
export { assignmentTools } from "./assignment-tools";
export {
  assignmentEnded,
  type AssignmentEnded,
  type AssignmentsService,
  assignmentsService,
} from "./assignments-service";
