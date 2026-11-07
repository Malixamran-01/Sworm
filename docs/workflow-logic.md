# Branching and connectors in the node editor (WF-009)

How Conclave decides which way a workflow goes. It covers what other tools do, what we built, how the engine decides, and what is left for later.

## What other tools do

| Tool | Branching | Rejoining | Failures |
| --- | --- | --- | --- |
| n8n | IF node (true/false); Switch node with rules, first match or [all matching outputs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.switch), optional fallback output | Merge node | Error output on a node |
| Make | Router with a **filter on each route** (the rule sits on the connector), fallback route | Separate routes don't rejoin | [Error routes](https://community.make.com/t/how-to-properly-fit-ignore-router-into-a-flow-with-an-http-request-which-might-fail/53473) that only run on failure; Resume, Ignore and Break handlers |
| Dify | If/Else with elif; [Question Classifier](https://legacy-docs.dify.ai/guides/workflow/node/question-classifier): a model picks a class, and each class is an output | [Variable Aggregator](https://docs.dify.ai/en/use-dify/nodes/variable-aggregator) passes on whichever exclusive branch ran | Per-node fail branch |
| BPMN / Camunda | [Exclusive gateway](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways): first true condition wins, otherwise the **default flow**; inclusive gateway takes every true one | Joining gateways | Boundary error events |
| Airflow | Branch operator; tasks on the other branch are marked skipped | A join needs a [trigger rule](https://www.astronomer.io/docs/learn/airflow-trigger-rules) such as `none_failed_min_one_success`, or it never runs after a branch | `one_failed` trigger rule |
| LangGraph | [Conditional edges](https://docs.langchain.com/oss/javascript/langgraph/graph-api-control-flow): a router picks the next node | Shared state | Recursion limit stops runaway loops |

What we took from them:
- Rules can sit on a node (n8n, Dify) or on the connector (Make, BPMN). We support both.
- An "otherwise" path is essential (BPMN default flow, n8n fallback output, Make fallback route).
- After a branch, a join must not wait for the branch that never ran (Airflow's lesson).
- AI routing, where a model picks the way, is the AI-native kind of switch (Dify).
- A failure path makes errors part of the graph instead of fatal (Make, n8n).

## What we built

**Nodes**

- **If / Switch**: tests a value against cases made of rules. With one case it's an If; with more, a Switch. It takes either the first matching case or every matching case, and Else when none match. Each case and Else is a separate output on the node.
- **AI router**: a model reads the text and picks one of your categories, each with an optional description. Each category is an output, and there's an optional Other output. An answer that names no category goes to Other.
- **Merge**: brings branches together. It passes on the first input with text (the branch that ran), joins all inputs with a separator, or makes a JSON object of every input by step.
- **Text**: writes its output from a template, with no model and no cost.
- **Stop**: ends the task here, either as done with a result or as failed with a reason. Branches still running are stopped.

**Connector types** (click a connector's label, or use the step's connector list):

- **Always**: taken when the step before finishes.
- **Only if**: taken when its rules hold for the step before's output.
- **Otherwise**: taken when none of that step's Only if connectors leaving the same output are taken.
- **On failure**: taken only if the step before fails after its retries. The failure is then handled, and the task carries on. You draw it from the red dot under a step.

Any connector can carry an **instruction** for the next step, such as "use only the figures". Model steps and the AI router get it with their input. A connector can also have a **label**, shown on the canvas.

**Rules** test the whole output or a field of a JSON output (`score`, `result.items[0]`). The tests are:

- text: contains, does not contain, is, is not, starts with, ends with;
- empty: is empty, is not empty;
- numbers: more than, at least, less than, at most;
- yes/no: is yes / true, is no / false.

Numbers are found inside text too, so "Score: 8/10" counts as more than 7. Combine rules with "every rule" or "any rule". Rules are data and never run code, which avoids injection and the risk of a slow regular expression. The same evaluator runs on the server and in the editor's **Try it** box.

**Joins**: when several connectors arrive at a step, it either:

- waits for each and runs if any arrived (the default);
- runs only if all of them arrived;
- or runs as soon as the first one arrives.

**Also:**
- **Turn a step off**: it is skipped and passes its input on.
- **Sticky notes** on the canvas.
- **Coloured connectors** with a legend.
- The task panel shows **Not taken** for steps on a branch that wasn't taken.

## How the engine decides

Each planning pass looks at every connector:

- **Undecided**: the step before hasn't finished.
- **Taken or not taken**: decided by `connectorTaken`, which reads the step's status, its chosen outputs, its output and the connector's rules.
- A step with nothing coming in runs at once. Otherwise its join mode turns the connector states into run, wait, or "not taken".
- "Not taken" spreads downstream in the same pass.
- A failed step only fails the task if no On failure connector leaves it.
- The task's result is the chosen result step. Without one, it's the last writing step (model, workspace, merge or text) that actually ran, so with branches it's the branch that was taken.

Checks when you save:
- An output a connector names must exist.
- A connector leaving an If/Switch or router must pick an output.
- Only if needs rules.
- On failure only leaves steps that call something.
- Nothing may follow a Stop.
- Case keys must be unique.

## Loops (WF-010)

A loop is a connector from a step back to an earlier step, or to itself. It's drawn as a violet arc under the nodes, from the violet dot on top of a step.

When the step that ends the loop finishes, Conclave checks the loop's "stop when" rules against that step's output:
- **The rules hold:** the loop ends, and later steps run with this round's output.
- **The rules don't hold, and rounds are left:** everything from the loop's start onward runs again.
- **The limit is reached** (1 to 20 rounds, 3 by default): the task either carries on with the last round or fails, whichever you chose.
- **No rules set:** it runs every round.

What steps can use:
- Inside a loop, templates can read `{{loop.index}}` (the round) and `{{loop.previous}}` (what the loop's end gave last round).
- If "tell it how the last round ended" is on, the model step where the loop starts also gets the last round's output with its prompt.

What happens to earlier rounds:
- They stay in the task as replaced rows, and the task panel shows each step's round.
- An approval still waiting inside the loop is withdrawn when a new round starts.
- A loop nested inside another restarts at round 1 on each outer round.
- Every round's model calls count toward the task's budget and the per-task call limits.

Checks when you save: a loop may only go back to its own step or one that runs before it, and a Stop step can't loop.

## Ideas for later

- **Wait**: a delay or a time-of-day step. The engine can already reschedule.
- **AI-judged connector**: a model answers a yes/no question about the output. Today you get the same with an AI router that has two categories.
- **Run view on the canvas**: colour each node by its status in a past task, like n8n's execution view.
- **Pinned sample data** per node, to try a step without running the task.
- **Sub-workflow ports**: named outputs for a workspace step, picked by the called task's Stop step.
