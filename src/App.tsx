import {ReactRunner} from "@chub-ai/stages-ts";
import {Stage} from "./Stage";

function App() {
  return <ReactRunner factory={(data: any) => new Stage(data)} />;
}

export default App
