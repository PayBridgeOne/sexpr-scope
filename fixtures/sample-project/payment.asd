;;;; payment.asd --- Sample ASDF system used by SexprScope fixtures.
;;;;
;;;; This file is intentionally simple. SexprScope reads .asd files
;;;; statically (without evaluating them) to discover the project model.

(asdf:defsystem "payment"
  :description "A tiny payment domain used to exercise SexprScope."
  :version "0.1.0"
  :author "SexprScope"
  :license "MIT"
  :serial t
  :components ((:module "src"
                :serial t
                :components ((:file "packages")
                             (:file "model")
                             (:file "services")))))
