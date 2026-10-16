import { Link } from "react-router-dom";
import { Card, Empty } from "../components/ui.jsx";

export default function NotFound() {
  return (
    <Card className="mx-auto mt-6 max-w-xl sm:mt-12">
      <Empty icon="search" title="Page not found" action={<Link to="/" className="btn-primary">Back to overview</Link>}>The page you're looking for doesn't exist or has moved.</Empty>
    </Card>
  );
}
