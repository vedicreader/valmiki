/* The pane's entry point: one module tag, and the graph underneath it.

   Each module still publishes what the HTML calls by name, the way it did when the eight files
   were one concatenated scope. What is added here is the other direction: twenty-one functions the
   rest of the client calls that no module published, because a bundle needed no publishing to be
   reachable and a module does. That list is a coupling report -- every name on it is somewhere
   else in Leela reaching into the pane, and every one has to be answered for when the pane moves
   out of this repository. */

import {loadAgentModels} from './panel.js';
import {setMemoryView} from './memory.js';
import {agentLog, agentTurnCards, currentAgentTurn, foldAgentTurn, foldAgentTurns, leeAgentBranches, leeAgentShape, usageMeta, warmAgentHistory} from './live.js';
import {showApproval} from './approvals.js';
import {agentTools, approvalLoop, initAgentComposer, paintAgentAttachments, pauseAgentAfterCurrent, renderAgentStep, showProblems, stopAgent} from './steer.js';
import {sendAgent} from './media.js';
import './host.js';
import './budgets.js';

Object.assign(window, {agentLog, agentTools, agentTurnCards, currentAgentTurn});
Object.assign(window, {foldAgentTurn, foldAgentTurns, initAgentComposer, leeAgentBranches});
Object.assign(window, {leeAgentShape, loadAgentModels, paintAgentAttachments, renderAgentStep});
Object.assign(window, {sendAgent, setMemoryView, showApproval, showProblems});
Object.assign(window, {stopAgent, usageMeta, approvalLoop, pauseAgentAfterCurrent});
Object.assign(window, {warmAgentHistory});
