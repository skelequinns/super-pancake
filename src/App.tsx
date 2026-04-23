import {ReactRunner} from "@chub-ai/stages-ts";
import {Stage} from "./Stage";
import {TestStageRunner} from "./TestRunner";

// Set VITE_TEST=true in .env.local (or the shell) to load the TestRunner
// instead of the live stage preview.  Never committed — stays local only.
const TEST_MODE = import.meta.env.VITE_TEST === 'false';

function App() {
  if (TEST_MODE) {
    return <TestStageRunner factory={(data: any) => new Stage(data)} />;
  }
  return <ReactRunner factory={(data: any) => new Stage(data)} />;
}

export default App
