;;;; model.lisp --- Domain types and special variables.

(in-package #:payment)

(defparameter *fee-rate* 0.03d0
  "Fraction of the transaction amount charged as a fee.")

(defclass transaction ()
  ((id :initarg :id :reader transaction-id)
   (amount :initarg :amount :reader transaction-amount))
  (:documentation "A single money movement."))

(define-condition insufficient-funds (error)
  ((required :initarg :required :reader insufficient-funds-required))
  (:documentation "Signalled when an account cannot cover a charge."))
