import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./styles.css";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Booking } from "./pages/Booking";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/book" element={<Booking />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </React.StrictMode>,
);
